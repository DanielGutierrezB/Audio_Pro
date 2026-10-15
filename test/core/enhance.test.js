'use strict';

// Tests for the embedded Adobe Enhance stage (docs/PLAN.md §3.1 Nivel 2 /
// Fase 10): output-path conventions, the shared credits gate, auth retry,
// reuse of an existing Enhanced/ file, and the local dry/wet mix render.
// The Adobe network client itself (phonos.enhanceToFile) is stubbed —
// these tests exercise the orchestration around it, plus the pure token
// helpers, without ever touching the endpoint.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const phonos = require('../../plugin/core/enhance/phonos');
const { runEnhanceBatch, enhancedPathFor, mixPathFor } = require('../../plugin/core/enhance/batch');
const { runFfprobe } = require('../../plugin/core/ffmpeg-run');
const binPaths = require('../../plugin/core/bin-paths');
const fx = require('./fixtures');

let workDir;
const realEnhanceToFile = phonos.enhanceToFile;

before(() => {
  workDir = fx.tmpDir('enhance');
});

after(() => {
  phonos.enhanceToFile = realEnhanceToFile;
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  phonos.enhanceToFile = realEnhanceToFile;
});

function collector() {
  const events = [];
  return { events, send: (type, data) => events.push({ type, ...data }) };
}

function baseDeps(extra) {
  return {
    getToken: () => 'tok',
    reauth: async () => null,
    isCanceled: () => false,
    ffmpeg: binPaths.ffmpeg(),
    ...extra,
  };
}

async function probeDuration(p) {
  const out = await runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_format', p]);
  return parseFloat(JSON.parse(out).format.duration);
}

// Stub that "enhances" by copying the input — keeps the pairing-relevant
// behavior (a WAV lands at outPath) without any network.
function stubEnhance(callsOut) {
  phonos.enhanceToFile = async (inPath, outPath, opts) => {
    if (callsOut) callsOut.push({ inPath, outPath, cleanVoice: opts.cleanVoice });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(inPath, outPath);
    if (opts.onStatus) opts.onStatus(phonos.STATES.LISTO, 100);
    return { ok: true, outPath, cleanVoice: 100 };
  };
}

test('enhancedPathFor / mixPathFor follow the adobe-podcast-batch folder convention', () => {
  const p = path.join('/tmp/curso', 'clase 01.mp3');
  assert.equal(enhancedPathFor(p), path.join('/tmp/curso', 'Enhanced', 'clase 01.wav'));
  assert.equal(mixPathFor(p, 80), path.join('/tmp/curso', 'Enhanced', 'Mix 80', 'clase 01.wav'));
});

test('runEnhanceBatch: saves the clean voice to Enhanced/ and reports it per file', async () => {
  const dir = path.join(workDir, 'happy');
  fs.mkdirSync(dir, { recursive: true });
  const src = await fx.buildTone(path.join(dir, 'clase.wav'), { duration: 2, frequency: 180, peakDb: -16 });
  const calls = [];
  stubEnhance(calls);
  const { events, send } = collector();

  const results = await runEnhanceBatch({ files: [src], mixPct: 100 }, baseDeps({ send }));

  const res = results.get(src);
  assert.ok(res.ok);
  assert.equal(res.enhancedPath, path.join(dir, 'Enhanced', 'clase.wav'));
  assert.ok(fs.existsSync(res.enhancedPath), 'clean voice must persist in Enhanced/');
  assert.equal(res.mixPath, null, 'no extra mix at 100%');
  assert.equal(res.reused, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cleanVoice, 100, 'always requests the pure 100% clean voice');
  const done = events.find(e => e.type === 'enhance:done');
  assert.ok(done && done.ok && done.enhancedPath === res.enhancedPath);
});

test('runEnhanceBatch: mixPct < 100 also renders Enhanced/Mix <pct>/ via ffmpeg', async () => {
  const dir = path.join(workDir, 'mix');
  fs.mkdirSync(dir, { recursive: true });
  const src = await fx.buildTone(path.join(dir, 'clase.wav'), { duration: 2, frequency: 180, peakDb: -16 });
  stubEnhance();
  const { send } = collector();

  const results = await runEnhanceBatch({ files: [src], mixPct: 80 }, baseDeps({ send }));

  const res = results.get(src);
  assert.ok(res.ok);
  assert.equal(res.mixPath, path.join(dir, 'Enhanced', 'Mix 80', 'clase.wav'));
  assert.ok(fs.existsSync(res.mixPath), 'the percentage mix must persist');
  const dur = await probeDuration(res.mixPath);
  assert.ok(Math.abs(dur - 2) < 0.15, `mix duration ${dur} should be ~2s`);
});

test('runEnhanceBatch: reuses an existing Enhanced/ file without spending credits', async () => {
  const dir = path.join(workDir, 'reuse');
  fs.mkdirSync(path.join(dir, 'Enhanced'), { recursive: true });
  const src = await fx.buildTone(path.join(dir, 'clase.wav'), { duration: 2 });
  fs.copyFileSync(src, path.join(dir, 'Enhanced', 'clase.wav'));
  const calls = [];
  stubEnhance(calls);
  const { send } = collector();

  const results = await runEnhanceBatch({ files: [src], mixPct: 100 }, baseDeps({ send }));

  const res = results.get(src);
  assert.ok(res.ok && res.reused, 'existing Enhanced/ file should be reused');
  assert.equal(calls.length, 0, 'no upload should have happened');
});

test('runEnhanceBatch: LIMIT arms the shared gate, waits, and retries the same file', async () => {
  const dir = path.join(workDir, 'limit');
  fs.mkdirSync(dir, { recursive: true });
  const src = await fx.buildTone(path.join(dir, 'clase.wav'), { duration: 2 });
  let attempts = 0;
  phonos.enhanceToFile = async (inPath, outPath) => {
    attempts++;
    if (attempts === 1) throw phonos.makeLimitError({ limits: { time_remaining: 1 } });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(inPath, outPath);
    return { ok: true, outPath, cleanVoice: 100 };
  };
  const { events, send } = collector();

  const results = await runEnhanceBatch({ files: [src], mixPct: 100 }, baseDeps({ send }));

  assert.equal(attempts, 2, 'the same file retries after the wait');
  assert.ok(results.get(src).ok);
  assert.ok(events.some(e => e.type === 'enhance:limit' && e.seconds === 1));
  assert.ok(events.some(e => e.type === 'enhance:limit-clear'));
});

test('runEnhanceBatch: AUTH retries after a successful reauth, fails the file otherwise', async () => {
  const dir = path.join(workDir, 'auth');
  fs.mkdirSync(dir, { recursive: true });
  const src1 = await fx.buildTone(path.join(dir, 'a.wav'), { duration: 2 });

  let attempts = 0;
  phonos.enhanceToFile = async (inPath, outPath) => {
    attempts++;
    if (attempts === 1) throw phonos.makeAuthError();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(inPath, outPath);
    return { ok: true, outPath, cleanVoice: 100 };
  };
  const { send } = collector();
  const ok = await runEnhanceBatch({ files: [src1], mixPct: 100 },
    baseDeps({ send, reauth: async () => 'fresh-token' }));
  assert.ok(ok.get(src1).ok, 'reauth success should let the file finish');

  const dir2 = path.join(workDir, 'auth-fail');
  fs.mkdirSync(dir2, { recursive: true });
  const src2 = await fx.buildTone(path.join(dir2, 'b.wav'), { duration: 2 });
  phonos.enhanceToFile = async () => { throw phonos.makeAuthError(); };
  const { events, send: send2 } = collector();
  const bad = await runEnhanceBatch({ files: [src2], mixPct: 100 }, baseDeps({ send: send2 }));
  assert.equal(bad.get(src2).ok, false);
  assert.ok(events.some(e => e.type === 'enhance:auth-expired'));
});

test('runEnhanceBatch: cancellation stops before the next file starts', async () => {
  const dir = path.join(workDir, 'cancel');
  fs.mkdirSync(dir, { recursive: true });
  const src1 = await fx.buildTone(path.join(dir, 'a.wav'), { duration: 2 });
  const src2 = await fx.buildTone(path.join(dir, 'b.wav'), { duration: 2 });
  let cancelled = false;
  phonos.enhanceToFile = async (inPath, outPath) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(inPath, outPath);
    cancelled = true; // cancel as soon as the first file lands
    return { ok: true, outPath, cleanVoice: 100 };
  };
  const { events, send } = collector();

  await runEnhanceBatch({ files: [src1, src2], mixPct: 100, concurrency: 1 },
    baseDeps({ send, isCanceled: () => cancelled }));

  const done = events.filter(e => e.type === 'enhance:done');
  assert.equal(done.length, 1, 'second file should never have started');
});

test('tokenInfo / isTokenExpired parse both JWT exp and IMS created_at formats', () => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
  const jwtWith = (payload) => `eyJhbGciOiJub25lIn0.${b64(payload)}.sig`;

  const live = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'a@b.co', client_id: 'x' });
  assert.equal(phonos.isTokenExpired(live), false);
  assert.equal(phonos.tokenInfo(live).email, 'a@b.co');

  const dead = jwtWith({ exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(phonos.isTokenExpired(dead), true);

  const ims = jwtWith({ created_at: String(Date.now() - 1000), expires_in: String(60 * 60 * 1000) });
  assert.equal(phonos.isTokenExpired(ims), false);

  assert.equal(phonos.tokenInfo('not-a-jwt').expiresAt, null);
});

test('makeLimitError derives retry seconds from time_remaining or retry_at_time', () => {
  const a = phonos.makeLimitError({ limits: { time_remaining: 90 } });
  assert.equal(a.code, 'LIMIT');
  assert.equal(a.retrySeconds, 90);

  const at = new Date(Date.now() + 30_000).toISOString();
  const b = phonos.makeLimitError({ limits: { retry_at_time: at } });
  assert.ok(b.retrySeconds >= 28 && b.retrySeconds <= 31);

  const c = phonos.makeLimitError(null);
  assert.equal(c.retrySeconds, null);
});
