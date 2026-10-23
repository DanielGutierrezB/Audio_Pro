'use strict';

// The Adobe client's job lifecycle, against a fake endpoint: how long it waits,
// what it reports when it gives up, and resuming a job instead of uploading it
// again. The network is never touched — global fetch is replaced per test.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const phonos = require('../../plugin/core/enhance/phonos');

let dir;
let realFetch;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-phonos-'));
  realFetch = global.fetch;
});
afterEach(() => {
  global.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body ?? ''),
  arrayBuffer: async () => Buffer.from('enhanced-audio'),
});

// An Adobe that accepts the upload and then answers `pollAnswers` in order
// (the last one repeating) when asked for the result.
function fakeAdobe(pollAnswers, trackAnswer) {
  const calls = [];
  let poll = 0;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    if (u.includes('direct_uploads')) {
      return response(200, { direct_upload: { url: 'https://storage/put', headers: {} }, signed_id: 'sig' });
    }
    if (u === 'https://storage/put') return response(200, {});
    if (u.includes('enhanced_audio')) {
      const [status, body] = pollAnswers[Math.min(poll++, pollAnswers.length - 1)];
      return response(status, body);
    }
    // The job's own status (GET /enhance_speech_tracks/<id>).
    if (/enhance_speech_tracks\/[^/?]+\?/.test(u) && (init.method || 'GET') === 'GET') {
      return trackAnswer ? response(...trackAnswer()) : response(200, { started_processing_at: '2026-10-23T19:00:00Z', limits: null });
    }
    if (u.includes('enhance_speech_tracks')) return response(200, { limits: {} });
    if (u === 'https://download/result') return response(200, {});
    throw new Error('unexpected request ' + u);
  };
  return calls;
}

function input() {
  const p = path.join(dir, 'clase.wav');
  fs.writeFileSync(p, 'audio');
  return p;
}

test('the job id is reported as soon as Adobe accepts the job', async () => {
  const calls = fakeAdobe([[204], [200, { url: 'https://download/result' }]]);
  const seen = [];
  await phonos.enhanceToFile(input(), path.join(dir, 'out.wav'), {
    token: 'eyJ.tok', pollMs: 1, onTrack: (id) => seen.push(id),
  });
  assert.equal(seen.length, 1);
  const created = calls.find(c => c.method === 'POST' && c.url.includes('enhance_speech_tracks'));
  assert.equal(JSON.parse(created.body).id, seen[0], 'the reported id is the one the job was created with');
});

test('giving up says so with a code and the job id, so the caller can resume', async () => {
  fakeAdobe([[204]]);
  await assert.rejects(
    phonos.enhanceToFile(input(), path.join(dir, 'out.wav'), {
      token: 'eyJ.tok', trackId: 'job-1', pollMs: 1, maxWaitMs: 20,
    }),
    (err) => {
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.trackId, 'job-1');
      assert.match(err.message, /sigue procesando .* HTTP 204/);
      return true;
    },
  );
});

test('the default wait is long enough for a long class', () => {
  // The old fixed cap was 6 minutes; classes of 25-40 minutes outran it.
  assert.ok(phonos.DEFAULT_MAX_WAIT_MS >= 30 * 60 * 1000);
});

test('resuming a job polls it and downloads the result without uploading again', async () => {
  const calls = fakeAdobe([[204], [200, { url: 'https://download/result' }]]);
  const out = path.join(dir, 'out.wav');
  await phonos.enhanceToFile(input(), out, { token: 'eyJ.tok', trackId: 'job-1', resume: true, pollMs: 1 });

  assert.ok(!calls.some(c => c.url.includes('direct_uploads')), 'no new upload');
  assert.ok(!calls.some(c => c.method === 'POST'), 'no new job — no new credits');
  assert.ok(calls.every(c => !c.url.includes('enhanced_audio') || c.url.includes('/job-1/')));
  assert.equal(fs.readFileSync(out, 'utf8'), 'enhanced-audio');
});

test('resuming a job Adobe no longer has fails fast with GONE', async () => {
  fakeAdobe([[404]]);
  await assert.rejects(
    phonos.enhanceToFile(input(), path.join(dir, 'out.wav'), {
      token: 'eyJ.tok', trackId: 'job-old', resume: true, pollMs: 1, maxWaitMs: 60000,
    }),
    (err) => err.code === 'GONE' && err.trackId === 'job-old',
  );
});

test('resume without a job id is a caller error, not a silent new upload', async () => {
  const calls = fakeAdobe([[204]]);
  await assert.rejects(
    phonos.enhanceToFile(input(), path.join(dir, 'out.wav'), { token: 'eyJ.tok', resume: true }),
    /necesita el trackId/,
  );
  assert.equal(calls.length, 0);
});

test('a job held by the daily limit ends the wait with LIMIT, not a 45-minute poll', async () => {
  // What Adobe actually does when the day's quota is used up: it accepts the
  // job, the result endpoint says 204 forever, and only the job itself says
  // it is limited — with the time the quota comes back.
  const retryAt = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  const calls = fakeAdobe([[204]], () => [200, {
    started_processing_at: null,
    limits: { 'is_limited?': true, time_remaining: 23031, retry_at_time: retryAt },
  }]);
  const started = Date.now();
  await assert.rejects(
    phonos.enhanceToFile(input(), path.join(dir, 'out.wav'), { token: 'eyJ.tok', trackId: 'job-1', pollMs: 1 }),
    (err) => {
      assert.equal(err.code, 'LIMIT');
      assert.equal(err.retrySeconds, 23031);
      assert.equal(err.trackId, 'job-1', 'the accepted job can be resumed after the reset');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'detected on the first status read');
  assert.ok(calls.some(c => /enhance_speech_tracks\/job-1\?/.test(c.url)));
});

test('a job that is not limited but never starts is reported as STUCK', async () => {
  fakeAdobe([[204]], () => [200, { started_processing_at: null, limits: null }]);
  await assert.rejects(
    phonos.enhanceToFile(input(), path.join(dir, 'out.wav'), {
      token: 'eyJ.tok', trackId: 'job-1', pollMs: 1, statusEvery: 1, stuckMs: 5,
    }),
    (err) => err.code === 'STUCK' && err.trackId === 'job-1',
  );
});

test('an error Adobe records on the job is reported instead of waiting', async () => {
  fakeAdobe([[204]], () => [200, { started_processing_at: '2026-10-23T19:00:00Z', error_type: 'invalid_audio' }]);
  await assert.rejects(
    phonos.enhanceToFile(input(), path.join(dir, 'out.wav'), { token: 'eyJ.tok', pollMs: 1 }),
    /invalid_audio/,
  );
});

test('a failed status read is not evidence of anything: the poll carries on', async () => {
  fakeAdobe([[204], [200, { url: 'https://download/result' }]], () => [500, {}]);
  const out = path.join(dir, 'out.wav');
  await phonos.enhanceToFile(input(), out, { token: 'eyJ.tok', pollMs: 1, statusEvery: 1 });
  assert.equal(fs.readFileSync(out, 'utf8'), 'enhanced-audio');
});
