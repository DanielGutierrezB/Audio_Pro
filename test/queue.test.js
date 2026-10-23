'use strict';

// The state machine, driven with every collaborator stubbed. Premiere, Adobe
// and the ffmpeg chain are all unavailable in a test runner, and none of them
// is what can go wrong here: what can go wrong is the order of the stages, what
// a failure leaves on the timeline, and whether a resumed queue spends credits
// it has already spent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const queueMod = require('../plugin/js/queue');
const { writeSilentWav } = require('./speech-fixture');
const panelSettings = require('../plugin/js/settings');
const { STAGE } = queueMod;

const PRESET = { presetPath: '/preset.epr' };

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-queue-'));
}

function touch(filePath, bytes = 'wav') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// A harness that records the order of everything and lets each stage be made
// to fail on demand. `overrides` is read at call time, so a test can flip a
// failure off between two runs to exercise the retry.
function harness(overrides = {}) {
  const calls = [];

  const host = {
    exportAudio: async (id, outPath, presetPath, workArea, wantIn, wantOut) => {
      calls.push({ name: 'export', id, outPath, workArea, wantIn, wantOut });
      if (overrides.exportFails) return { ok: false, error: 'NO_PRESET' };
      // A real export takes seconds and the file appears at the end; landing it
      // after a tick is what lets the same-name race show up in a test.
      await tick();
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      writeSilentWav(outPath, overrides.exportedSeconds ?? 1);
      // Like host.jsx: an In→Out export reports the In it exported from.
      const inPoint = overrides.inPoint ?? (workArea === 1 && wantIn != null ? wantIn : 0);
      return { ok: true, outPath, inPoint, expectedSeconds: overrides.expectedSeconds ?? 1 };
    },
    placeEnhanced: async (id, wavPath, mute, start, label, placement) => {
      calls.push({ name: 'place', id, wavPath, mute, start, label, placement });
      if (overrides.placeFails) return { ok: false, error: 'no encontré pista vacía' };
      return { ok: true, nodeId: 'node-' + id, track: 2, placedAt: Number(start) };
    },
    relinkMaster: async (nodeId, masterPath, label) => {
      calls.push({ name: 'relink', nodeId, masterPath, label });
      if (overrides.relinkLost) return { ok: false, error: 'NODE_NOT_FOUND' };
      if (overrides.relinkFails) return { ok: false, error: 'changeMediaPath falló' };
      return { ok: true, path: masterPath };
    },
    renameItem: async (nodeId, name) => { calls.push({ name: 'rename', nodeId, newName: name }); return { ok: true }; },
  };

  const phonos = {
    enhanceToFile: async (inPath, outPath, opts) => {
      calls.push({ name: 'adobe', inPath, outPath, cleanVoice: opts.cleanVoice });
      await tick();
      // Returning nothing from adobeError is how a test says "this attempt
      // succeeds", which is what the retry cases need.
      if (overrides.adobeError) {
        const err = overrides.adobeError();
        if (err) throw err;
      }
      touch(outPath);
      return { ok: true, outPath };
    },
  };

  const aligner = {
    alignToOriginal: async (originalPath, rawPath, outPath) => {
      calls.push({ name: 'align', originalPath, rawPath, outPath });
      touch(outPath);
      return { ok: true, outPath, note: overrides.alignNote ?? null, shiftSec: 0, correlation: 0.97 };
    },
    masterMatchesOriginal: async () => (
      overrides.drift
        ? { ok: false, drift: overrides.drift, reason: 'el master dura de más' }
        : { ok: true, drift: 0 }
    ),
  };

  const mastering = {
    masterOne: async ({ originalPath, enhancedPath, settings, onProgress }) => {
      calls.push({ name: 'master', originalPath, enhancedPath, settings });
      if (onProgress) onProgress('Rendering', 50);
      await tick();
      if (overrides.masterFails) return { ok: false, error: 'ffmpeg explotó' };
      const outputPath = path.join(settings.customOutputDir, path.basename(originalPath));
      touch(outputPath);
      return {
        ok: true,
        outputPath,
        mode: overrides.mode ?? 2,
        verify: overrides.verify ?? { i: -16.1, tp: -2.4, badge: 'ok' },
        flags: [],
      };
    },
    describeResult: () => 'master ok',
  };

  const limit = { limited: false, msRemaining: 0, reportedAt: 0 };
  const session = {
    token: 'tok',
    getToken: () => session.token,
    hasToken: () => true,
    limitState: () => limit,
    armLimit: (secs) => { calls.push({ name: 'armLimit', secs }); limit.limited = true; },
    trySilentReauth: async () => {
      calls.push({ name: 'reauth' });
      return overrides.reauthWorks ? 'fresh' : null;
    },
  };

  const notes = [];
  const lost = { count: 0 };
  const queue = queueMod.createQueue({
    host,
    phonos,
    aligner,
    mastering,
    session,
    getSettings: () => panelSettings.defaults(),
    // The real one: the Premiere-path invariants it enforces (trimSilence and
    // skipUnchanged off) are what the layout test below asserts reach the chain.
    pipelineSettings: panelSettings.pipelineSettings,
    log: () => {},
    notify: (msg, type) => notes.push({ msg, type }),
    onSessionLost: () => { lost.count++; },
    exportPollMs: 1,
    exportStallMs: overrides.exportStallMs ?? 2000,
  });

  return { queue, calls, notes, names: () => calls.map(c => c.name), limit, session, lost };
}

test('the happy path runs every stage in order and ends on the master', async () => {
  const dir = tmpProject();
  const { queue, calls, names } = harness({ projectDir: dir });
  queue.attach(dir);
  const item = queue.upsert({ id: '1', name: 'clase 01' });

  const res = await queue.run([item], PRESET);

  assert.equal(res.done, 1);
  assert.deepEqual(names(), ['export', 'adobe', 'align', 'place', 'master', 'relink', 'rename']);
  assert.equal(item.stage, STAGE.DONE);
  assert.equal(item.nodeId, 'node-1');
  assert.equal(item.mode, 2);
  assert.equal(queue.view(item).text, '✓ master');

  // The clip goes on the timeline in the in-progress colour and only turns to
  // the done colour at the relink — that transition is the whole user-visible
  // contract of the two-stage flow.
  assert.equal(calls.find(c => c.name === 'place').label, 7);
  assert.equal(calls.find(c => c.name === 'relink').label, 13);
  // Adobe is always asked for the pure clean voice; the blend belongs to the core.
  assert.equal(calls.find(c => c.name === 'adobe').cleanVoice, 100);
});

test('what lands on disk follows the Audio_Process layout', async () => {
  const dir = tmpProject();
  const { queue, calls } = harness({ projectDir: dir });
  queue.attach(dir);
  const item = queue.upsert({ id: '7', name: 'clase 02' });
  await queue.run([item], PRESET);

  assert.equal(item.paths.original, path.join(dir, 'Audio_Process', 'clase 02.wav'));
  assert.equal(item.paths.enhancedRaw, path.join(dir, 'Audio_Process', 'Enhanced', 'clase 02.raw.wav'));
  assert.equal(item.paths.enhanced, path.join(dir, 'Audio_Process', 'Enhanced', 'clase 02.wav'));

  // The pipeline is told to write into Audio_Process/Audio_Pro rather than its
  // own default (a sibling of the input), and the two settings the Premiere
  // path cannot work without are set.
  const master = calls.find(c => c.name === 'master');
  assert.equal(master.settings.customOutputDir, path.join(dir, 'Audio_Process', 'Audio_Pro'));
  assert.equal(master.settings.trimSilence, false);
  assert.equal(master.settings.skipUnchanged, false);

  // The chain gets the *aligned* enhanced file, never the raw return.
  assert.equal(master.enhancedPath, item.paths.enhanced);
});

test('an In→Out run normalises raiseOnly and never mutes the other tracks', async () => {
  const dir = tmpProject();
  const { queue, calls } = harness({ projectDir: dir, inPoint: 12.5 });
  queue.attach(dir);
  const item = queue.addInOut({ id: '3', name: 'clase' }, { in: 12.5, out: 15.2 });
  await queue.run([item], PRESET);

  const place = calls.find(c => c.name === 'place');
  // Muting silences a whole track, which outside the region would kill the
  // rest of the timeline.
  assert.equal(place.mute, 0);
  // The clip starts at the In point so it lines up with what was processed.
  assert.equal(place.start, '12.5');
  assert.equal(calls.find(c => c.name === 'master').settings.normalizeMode, 'raiseOnly');
  assert.match(item.paths.original, /clase_inout_0m12s-0m16s\.wav$/);
  // Exported from the sequence it belongs to, with the marks it was given.
  const exp = calls.find(c => c.name === 'export');
  assert.deepEqual([exp.id, exp.workArea, exp.wantIn, exp.wantOut], ['3', 1, 12.5, 15.2]);
});

test('a failed master leaves the clip placed, and retrying re-runs only the master', async () => {
  const dir = tmpProject();
  const overrides = { projectDir: dir, masterFails: true };
  const h = harness(overrides);
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  // The stage is still "master next" and the row carries the error: that is
  // the whole retry contract.
  assert.equal(item.stage, STAGE.MASTERING);
  assert.match(item.error, /ffmpeg explotó/);
  assert.equal(item.nodeId, 'node-1', 'the clip is still on the timeline');
  assert.ok(h.queue.view(item).retry, 'the row offers a retry');
  assert.ok(!h.names().includes('relink'), 'nothing was relinked');

  overrides.masterFails = false;
  h.calls.length = 0;
  h.queue.clearErrors([item.id]);
  const retry = await h.queue.run([item], PRESET);
  assert.equal(retry.done, 1);
  assert.deepEqual(h.names(), ['master', 'relink', 'rename']);
  assert.equal(item.error, null);
  assert.equal(item.stage, STAGE.DONE);
});

test('a failure after Adobe never pays Adobe twice', async () => {
  const dir = tmpProject();
  const overrides = { projectDir: dir, placeFails: true };
  const h = harness(overrides);
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);
  assert.equal(item.stage, STAGE.PLACING);
  assert.ok(item.error);

  overrides.placeFails = false;
  h.calls.length = 0;
  h.queue.clearErrors([item.id]);
  await h.queue.run(h.queue.pending(), PRESET);
  assert.deepEqual(h.names(), ['place', 'master', 'relink', 'rename'],
    'the retry starts at the stage that failed, with the Adobe return already on disk');
  assert.match(item.paths.original, /clase\.wav$/, 'and it did not become clase_2');
});

test('a failed relink retries the relink alone, not the master', async () => {
  const dir = tmpProject();
  const overrides = { projectDir: dir, relinkFails: true };
  const h = harness(overrides);
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);
  assert.equal(item.stage, STAGE.RELINKING);

  overrides.relinkFails = false;
  h.calls.length = 0;
  h.queue.clearErrors([item.id]);
  await h.queue.run([item], PRESET);
  assert.deepEqual(h.names(), ['relink', 'rename'], 'a finished master is not rendered again');
  assert.equal(item.stage, STAGE.DONE);
});

test('a clip removed while mastering is placed again on retry, without credits', async () => {
  const dir = tmpProject();
  const overrides = { projectDir: dir, relinkLost: true };
  const h = harness(overrides);
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);
  assert.equal(item.stage, STAGE.PLACING);
  assert.equal(item.nodeId, null);
  assert.match(item.error, /ya no está/);

  overrides.relinkLost = false;
  h.calls.length = 0;
  h.queue.clearErrors([item.id]);
  await h.queue.run([item], PRESET);
  assert.ok(!h.names().includes('adobe'));
  assert.equal(h.names()[0], 'place');
  assert.equal(item.stage, STAGE.DONE);
});

test('mode 1 blocks the relink for good: no retry, no pending count', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, mode: 1 });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  assert.ok(!h.names().includes('relink'));
  assert.equal(item.blocked, 'PAIR_MISMATCH');
  assert.ok(h.notes.some(n => /par con Adobe/.test(n.msg)));
  // Re-mastering the same pair gives the same answer, so offering "retry"
  // would be a loop. Only a fresh run can change anything.
  assert.equal(h.queue.view(item).retry, false);
  assert.equal(h.queue.pending().length, 0);

  h.calls.length = 0;
  await h.queue.run([item], PRESET);
  assert.deepEqual(h.names(), [], 'running it again does nothing');

  const fresh = h.queue.upsert({ id: '1', name: 'clase' });
  assert.equal(fresh.stage, STAGE.PENDING, '"Secuencia activa" starts a fresh run');
  assert.equal(fresh.blocked, null);
});

test('a master whose length drifted from the original is never relinked', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, drift: 3.2 });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  assert.ok(!h.names().includes('relink'), 'relinking would desync the sequence');
  assert.equal(item.blocked, 'SYNC');
  assert.match(item.error, /sincronía/);
});

test('a verify warning still relinks — it is a note, not a veto', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, verify: { i: -15.1, tp: -2.0, badge: 'warn' } });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  assert.ok(h.names().includes('relink'));
  assert.equal(item.stage, STAGE.DONE);
  assert.match(h.queue.view(item).text, /-15\.1/);
});

test('a pair that could not be aligned is placed but not mastered unattended', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, alignNote: 'PAIR?' });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  const res = await h.queue.run([item], PRESET);

  assert.deepEqual(h.names(), ['export', 'adobe', 'align', 'place']);
  assert.equal(item.stage, STAGE.MASTERING, 'master is next, once the editor has looked');
  assert.deepEqual(res, { done: 0, partial: 1, waiting: 0, failed: 0 }, 'not counted as finished');
  assert.match(h.queue.view(item).text, /revisá el par/);

  // Running it again is how the editor says "it's fine, master it".
  h.calls.length = 0;
  await h.queue.run([item], PRESET);
  assert.deepEqual(h.names(), ['master', 'relink', 'rename']);
});

test('an export failure stops before a single credit is spent', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, exportFails: true });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  assert.deepEqual(h.names(), ['export']);
  assert.match(item.error, /preset/);
});

test('a credits limit makes the row wait at the Adobe stage, and resuming does not re-export', async () => {
  const dir = tmpProject();
  const overrides = {
    projectDir: dir,
    adobeError: () => Object.assign(new Error('sin créditos'), { code: 'LIMIT', retrySeconds: 90 }),
  };
  const h = harness(overrides);
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  assert.ok(h.calls.some(c => c.name === 'armLimit' && c.secs === 90));
  assert.equal(item.stage, STAGE.ENHANCING);
  // Nothing is wrong with the sequence: it waits, it does not fail.
  assert.equal(item.error, null);
  assert.match(h.queue.view(item).text, /esperando créditos/);
  assert.equal(h.queue.pending().length, 1);

  // An hour later: the export is already on disk, so only Adobe onwards runs.
  h.limit.limited = false;
  overrides.adobeError = null;
  h.calls.length = 0;
  await h.queue.run(h.queue.pending(), PRESET);
  assert.equal(h.names()[0], 'adobe');
  assert.ok(!h.names().includes('export'));
});

test('sequences queued behind a credits limit do not each go and ask Adobe', async () => {
  const dir = tmpProject();
  const h = harness({
    projectDir: dir,
    adobeError: () => Object.assign(new Error('sin créditos'), { code: 'LIMIT', retrySeconds: 60 }),
  });
  h.queue.attach(dir);
  const items = ['1', '2', '3'].map(id => h.queue.upsert({ id, name: 'clase ' + id }));

  await h.queue.run(items, PRESET);

  // Two slots in the Adobe lane: at most the two in flight when the limit hit
  // talk to Adobe; the third sees the gate and never makes the request.
  assert.ok(h.calls.filter(c => c.name === 'adobe').length <= 2);
  for (const item of items) assert.equal(item.stage, STAGE.ENHANCING);
});

test('a 401 is retried once behind a silent reauth', async () => {
  const dir = tmpProject();
  let thrown = 0;
  const h = harness({
    projectDir: dir,
    reauthWorks: true,
    adobeError: () => (thrown++ === 0 ? Object.assign(new Error('401'), { code: 'AUTH' }) : undefined),
  });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  assert.deepEqual(h.names(), [
    'export', 'adobe', 'reauth', 'adobe', 'align', 'place', 'master', 'relink', 'rename',
  ]);
  assert.equal(item.stage, STAGE.DONE);
});

test('two sequences with the same name never export over each other', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const a = h.queue.upsert({ id: '1', name: 'clase' });
  const b = h.queue.upsert({ id: '2', name: 'clase' });

  await h.queue.run([a, b], PRESET);

  const exports = h.calls.filter(c => c.name === 'export').map(c => c.outPath);
  assert.equal(new Set(exports).size, 2, `both exported to ${exports[0]}`);
  assert.notEqual(a.paths.master, b.paths.master);
});

test('a row already running is not started a second time', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  // A double click, or the row's retry button pressed while "Procesar" is
  // still on its way: two runs of one row would be two exports and two uploads.
  const [first, second] = await Promise.all([h.queue.run([item], PRESET), h.queue.run([item], PRESET)]);

  assert.equal(h.calls.filter(c => c.name === 'export').length, 1);
  assert.equal(h.calls.filter(c => c.name === 'adobe').length, 1);
  assert.equal(first.done + second.done, 1);
});

test('"Secuencia activa" on an unfinished row resumes it instead of starting over', async () => {
  const dir = tmpProject();
  const overrides = { projectDir: dir, masterFails: true };
  const h = harness(overrides);
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.run([item], PRESET);

  const again = h.queue.upsert({ id: '1', name: 'clase' });
  assert.equal(again, item);
  assert.equal(again.stage, STAGE.MASTERING, 'not reset: the Adobe pass is already paid for');
  assert.equal(again.error, null, 'pressing the button on it is the explicit retry');

  // An In→Out on the same sequence is a separate row and leaves this one alone.
  const inout = h.queue.addInOut({ id: '1', name: 'clase' }, { in: 1, out: 2 });
  assert.equal(inout.stage, STAGE.PENDING);
  assert.equal(item.stage, STAGE.MASTERING);
});

test('upsert refuses a row that is running', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });
  const running = h.queue.run([item], PRESET);
  assert.equal(h.queue.upsert({ id: '1', name: 'clase' }), null);
  assert.equal(h.queue.view(item).tone, 'work');
  await running;
});

test('re-attaching to the open project keeps the live rows', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  // Every button calls attach first. If that reloaded queue.json it would swap
  // the rows a running render is updating for stale copies, and treat the pids
  // of the ffmpeg it is running as orphans to kill.
  const again = h.queue.attach(dir);
  assert.equal(h.queue.get('1'), item, 'the same object, not a reloaded copy');
  assert.equal(again.length, 1);
});

test('reprocessing writes _2 instead of overwriting a file the timeline points at', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);

  const first = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.run([first], PRESET);
  const firstPaths = { ...first.paths };

  const second = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.run([second], PRESET);

  assert.equal(second.runIndex, 2);
  assert.match(second.paths.original, /clase_2\.wav$/);
  assert.notEqual(second.paths.original, firstPaths.original);
  assert.ok(fs.existsSync(firstPaths.original), 'the first run survives untouched');
});

test('the queue file survives a reload and resumes from the right stage', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.run([item], PRESET);

  const queueFile = path.join(dir, 'Audio_Process', 'queue.json');
  const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.equal(saved.version, queueMod.QUEUE_VERSION);
  assert.equal(saved.items[0].stage, STAGE.DONE);
  assert.equal(saved.items[0].status, undefined, 'what a row says is derived, never stored');

  // Rewrite it as if the panel had died while mastering, then reattach.
  saved.items[0].stage = STAGE.MASTERING;
  fs.writeFileSync(queueFile, JSON.stringify(saved));

  const fresh = harness({ projectDir: dir });
  const restored = fresh.queue.attach(dir);
  assert.equal(restored[0].stage, STAGE.MASTERING, 'both intermediates are on disk, so it resumes at the master');
  // Nothing is running in this panel, so the row must not claim otherwise.
  assert.equal(fresh.queue.view(restored[0]).tone, 'idle');
  assert.doesNotMatch(fresh.queue.view(restored[0]).text, /masterizando/);

  fresh.calls.length = 0;
  await fresh.queue.run(fresh.queue.pending(), PRESET);
  assert.deepEqual(fresh.names(), ['master', 'relink', 'rename'], 'no export, and no credits spent again');
});

function writeQueue(dir, items) {
  const work = path.join(dir, 'Audio_Process');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify({ version: queueMod.QUEUE_VERSION, items }));
  return work;
}

test('a resume whose intermediates are gone starts over instead of mastering nothing', () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  writeQueue(dir, [{
    id: '1', name: 'clase', stage: STAGE.MASTERING, nodeId: 'n',
    paths: { original: path.join(work, 'clase.wav'), enhanced: path.join(work, 'Enhanced', 'clase.wav') },
  }]);
  const items = harness({ projectDir: dir }).queue.attach(dir);
  assert.equal(items[0].stage, STAGE.PENDING);
});

test('a resume falls back one stage at a time, never further than it has to', () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  const p = {
    original: path.join(work, 'clase.wav'),
    enhancedRaw: path.join(work, 'Enhanced', 'clase.raw.wav'),
    enhanced: path.join(work, 'Enhanced', 'clase.wav'),
    master: path.join(work, 'Audio_Pro', 'clase.wav'),
  };
  touch(p.original);
  touch(p.enhancedRaw);
  // The aligned file is gone but Adobe's raw return is not: that is a re-align
  // away from placing, not a re-export and a second Adobe bill.
  const ok = { exportVerified: true };
  assert.equal(queueMod.resumeStageFor({ ...ok, stage: STAGE.PLACING, paths: p }), STAGE.ALIGNING);
  assert.equal(queueMod.resumeStageFor({ ...ok, stage: STAGE.MASTERING, paths: p, nodeId: 'n' }), STAGE.ALIGNING);
  // Adobe's return landed before the panel died: skip straight past Adobe.
  assert.equal(queueMod.resumeStageFor({ ...ok, stage: STAGE.ENHANCING, paths: p }), STAGE.ALIGNING);
  // A relink whose master is missing re-renders the master, given the clip.
  touch(p.enhanced);
  assert.equal(queueMod.resumeStageFor({ ...ok, stage: STAGE.RELINKING, paths: p, nodeId: 'n', mode: 2 }), STAGE.MASTERING);
  // A clip that already landed is not placed a second time.
  assert.equal(queueMod.resumeStageFor({ ...ok, stage: STAGE.PLACING, paths: p, nodeId: 'n' }), STAGE.MASTERING);
  // And none of it counts if the export was never checked complete.
  assert.equal(queueMod.resumeStageFor({ stage: STAGE.RELINKING, paths: p, nodeId: 'n', mode: 2 }), STAGE.PENDING);
});

test('a resume that already has Adobe\'s return re-aligns instead of paying again', async () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  const raw = path.join(work, 'Enhanced', 'clase.raw.wav');
  touch(path.join(work, 'clase.wav'));
  touch(raw);
  writeQueue(dir, [{
    id: '1', name: 'clase', stage: STAGE.ENHANCING, stem: 'clase', exportVerified: true,
    paths: {
      original: path.join(work, 'clase.wav'),
      enhancedRaw: raw,
      enhanced: path.join(work, 'Enhanced', 'clase.wav'),
      master: path.join(work, 'Audio_Pro', 'clase.wav'),
    },
  }]);

  const h = harness({ projectDir: dir });
  const items = h.queue.attach(dir);
  assert.equal(items[0].stage, STAGE.ALIGNING);

  await h.queue.run(h.queue.pending(), PRESET);
  assert.deepEqual(h.names(), ['align', 'place', 'master', 'relink', 'rename']);
});

test('a v1 queue from the Adobe Podcast panel is migrated, not discarded', () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  fs.mkdirSync(work, { recursive: true });
  // v1 was a bare array of { id, name, done }.
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify([
    { id: '10', name: 'clase 01', done: true },
    { id: '11', name: 'clase 02', done: false },
  ]));

  const items = harness({ projectDir: dir }).queue.attach(dir);

  assert.equal(items.length, 2);
  assert.equal(items[0].stage, STAGE.DONE);
  assert.equal(items[1].stage, STAGE.PENDING);
  assert.equal(items[1].name, 'clase 02');
});

test('a corrupt queue.json is set aside, not overwritten', () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'queue.json'), '{"version":2,"items":[{"id":"1","na');

  const h = harness({ projectDir: dir });
  assert.deepEqual(h.queue.attach(dir), []);

  const aside = fs.readdirSync(work).find(f => f.startsWith('queue.json.corrupt-'));
  assert.ok(aside, 'what survived in the broken file is still there to recover by hand');
  assert.match(fs.readFileSync(path.join(work, aside), 'utf8'), /"na$/);
  assert.ok(h.notes.some(n => /dañada/.test(n.msg)));
});

test('queue.json is replaced atomically, never written in place', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  await h.queue.run([h.queue.upsert({ id: '1', name: 'clase' })], PRESET);

  const work = path.join(dir, 'Audio_Process');
  assert.ok(!fs.existsSync(path.join(work, 'queue.json.tmp')), 'the temp file is renamed over, not left behind');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(work, 'queue.json'), 'utf8')));
});

test('a failed row is parked: Procesar skips it until "reintentar" puts it back', async () => {
  const dir = tmpProject();
  const overrides = { projectDir: dir, placeFails: true };
  const h = harness(overrides);
  h.queue.attach(dir);
  const failed = h.queue.upsert({ id: '1', name: 'falla' });
  await h.queue.run([failed], PRESET);
  const other = h.queue.upsert({ id: '2', name: 'otra' });
  overrides.placeFails = false;

  // Procesar runs what is pending, and a row with an error is not: running it
  // again on every Procesar would just fail again (or prompt again).
  assert.deepEqual(h.queue.pending().map(i => i.id), ['2']);
  h.calls.length = 0;
  await h.queue.run([failed, other], PRESET);
  assert.ok(h.calls.every(c => c.id !== '1' && !String(c.wavPath || c.outPath || '').includes('falla')),
    'the parked row was not touched');
  assert.equal(other.stage, STAGE.DONE);

  // "reintentar" only clears the error — it does not run anything.
  h.calls.length = 0;
  assert.equal(h.queue.clearErrors(['1']), 1);
  assert.deepEqual(h.calls, []);
  assert.equal(failed.error, null);
  assert.equal(failed.stage, STAGE.PLACING, 'the work already done is kept');
  assert.equal(h.queue.view(failed).tone, 'idle');

  await h.queue.run(h.queue.pending(), PRESET);
  assert.equal(h.names()[0], 'place');
  assert.equal(failed.stage, STAGE.DONE);
});

test('reintentar does not un-block a row whose master must not replace the clip', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, mode: 1 });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.run([item], PRESET);
  assert.equal(h.queue.clearErrors(['1']), 0);
  assert.ok(item.error);
});

test('rows can be taken off the list; a running one stays until it finishes', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  h.queue.addSequences([{ id: '1', name: 'a' }, { id: '2', name: 'b' }, { id: '3', name: 'c' }]);
  const busy = h.queue.run([h.queue.get('3')], PRESET);

  assert.equal(h.queue.remove(['1', '3']), 1, 'only the idle one goes');
  assert.deepEqual(h.queue.all().map(i => i.id), ['2', '3']);
  await busy;

  assert.equal(h.queue.remove(['2', '3']), 2);
  assert.deepEqual(h.queue.all(), []);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'Audio_Process', 'queue.json'), 'utf8'));
  assert.deepEqual(saved.items, [], 'the removal is saved');
});

test('an expired Adobe session is handled once per batch, not once per row', async () => {
  const dir = tmpProject();
  const overrides = {
    projectDir: dir,
    // Adobe rejects this token every time, and the silent refresh cannot fix it.
    adobeError: () => (h.session.token === 'tok' ? Object.assign(new Error('401'), { code: 'AUTH' }) : undefined),
  };
  const h = harness(overrides);
  h.queue.attach(dir);
  const items = ['1', '2', '3', '4'].map(id => h.queue.upsert({ id, name: 'clase ' + id }));

  const res = await h.queue.run(items, PRESET);

  // One refresh attempt and one login request for the whole batch.
  assert.equal(h.calls.filter(c => c.name === 'reauth').length, 1);
  assert.equal(h.lost.count, 1);
  // At most the rows already in the two Adobe slots asked; the rest waited.
  assert.ok(h.calls.filter(c => c.name === 'adobe').length <= 2);
  // None of them failed: they are waiting for the session, still pending.
  assert.equal(res.failed, 0);
  assert.equal(res.waiting, 4);
  for (const item of items) {
    assert.equal(item.error, null);
    assert.match(h.queue.view(item).text, /esperando la sesión/);
  }
  assert.equal(h.queue.pending().length, 4);

  // The login lands with a new token: the same rows pick up from Adobe on.
  h.session.token = 'tok-nuevo';
  h.calls.length = 0;
  const after = await h.queue.run(h.queue.pending(), PRESET);
  assert.equal(after.done, 4);
  assert.ok(!h.names().includes('export'), 'the exports were already done');
});

test('rows reaching Adobe after the token was dropped wait instead of failing', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });
  h.session.token = null;   // the panel cleared the dead token to ask for a login

  const res = await h.queue.run([item], PRESET);

  assert.equal(res.waiting, 1);
  assert.equal(item.error, null);
  assert.ok(!h.names().includes('adobe'));
});

test('an export Premiere leaves short never goes to Adobe', async () => {
  const dir = tmpProject();
  // The sequence is a minute long; the file stops at one second and stays.
  const h = harness({ projectDir: dir, expectedSeconds: 60, exportedSeconds: 1, exportStallMs: 30 });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.run([item], PRESET);

  assert.deepEqual(h.names(), ['export'], 'Adobe was never asked for a cut-short export');
  assert.match(item.error, /export incompleto: Premiere dejó de escribir en 0:01 de 1:00/);
  assert.equal(item.exportVerified, false);
});

test('rows whose export was never verified are exported again, not sent to Adobe', async () => {
  // Exactly the queue.json a panel without the export check left behind: rows
  // waiting at the Adobe stage on exports that were cut to a minute.
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  const original = path.join(work, 'clase.wav');
  touch(original);
  writeQueue(dir, [
    { id: '1', name: 'clase', stage: STAGE.ENHANCING, stem: 'clase', paths: { original } },
    { id: '2', name: 'otra', stage: STAGE.ENHANCING, stem: 'otra', paths: { original }, error: 'sesión de Adobe expirada' },
  ]);

  const h = harness({ projectDir: dir });
  const [item, errored] = h.queue.attach(dir);
  assert.equal(item.stage, STAGE.PENDING);
  // Going back to the start makes an error about a later stage meaningless,
  // so it does not keep the row parked.
  assert.equal(errored.stage, STAGE.PENDING);
  assert.equal(errored.error, null);
  h.queue.remove(['2']);

  await h.queue.run(h.queue.pending(), PRESET);
  assert.equal(h.names()[0], 'export');
  assert.match(item.paths.original, /clase_2\.wav$/, 'the old cut-short file is left alone');
  assert.equal(item.stage, STAGE.DONE);
});

test('the same check runs for a row already in memory, not only on load', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.run([item], PRESET);
  const paths = { ...item.paths };

  // A row about to master, whose Enhanced folder was deleted after the fact.
  Object.assign(item, { stage: STAGE.MASTERING, paths, nodeId: 'node-1', exportVerified: true });
  fs.rmSync(path.dirname(paths.enhanced), { recursive: true, force: true });
  h.calls.length = 0;
  await h.queue.run([item], PRESET);
  assert.equal(h.names()[0], 'adobe', 'back to Adobe, because the aligned file and the raw return are gone');
});

test('every In→Out is its own row, with its own name, next to the whole-class run', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const whole = h.queue.upsert({ id: 'seq1', name: 'clase 01' });
  await h.queue.run([whole], PRESET);

  // The editor extends two cuts, and patches both — one region twice.
  const a = h.queue.addInOut({ id: 'seq1', name: 'clase 01' }, { in: 459.6, out: 460.8 });
  const b = h.queue.addInOut({ id: 'seq1', name: 'clase 01' }, { in: 588.5, out: 589.9 });
  await h.queue.run([a, b], PRESET);
  const again = h.queue.addInOut({ id: 'seq1', name: 'clase 01' }, { in: 459.6, out: 460.8 });
  await h.queue.run([again], PRESET);

  assert.equal(h.queue.all().length, 4, 'nothing replaced anything');
  assert.equal(whole.stage, STAGE.DONE, 'the whole-class row is untouched');
  assert.deepEqual(
    [a, b, again].map(i => path.basename(i.paths.master)),
    ['clase 01_inout_7m39s-7m41s.wav', 'clase 01_inout_9m48s-9m50s.wav', 'clase 01_inout_7m39s-7m41s_2.wav'],
  );
  // All of them export from and place into the same Premiere sequence.
  assert.ok(h.calls.filter(c => c.name === 'export' || c.name === 'place').every(c => c.id === 'seq1'));
  // And the bin never ends up with two items of the same name.
  const binNames = h.calls.filter(c => c.name === 'rename').map(c => c.newName);
  assert.equal(new Set(binNames).size, binNames.length, binNames.join(' | '));
  assert.ok(binNames.includes('clase 01 · Audio Pro'));
  assert.ok(binNames.includes('clase 01_inout_9m48s-9m50s · Audio Pro'));
  assert.equal(queueMod.regionText(b.region), '9:48–9:50', 'the row says the same region as the file');
});

test('an In→Out patch goes on a new track of its own, and the panel says which', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  await h.queue.run([h.queue.upsert({ id: 'seq1', name: 'clase' })], PRESET);
  const patch = h.queue.addInOut({ id: 'seq1', name: 'clase' }, { in: 80.6, out: 81.3 });
  await h.queue.run([patch], PRESET);

  const places = h.calls.filter(c => c.name === 'place');
  // The whole class keeps its placement; the patch asks for a new track.
  assert.deepEqual(places.map(c => c.placement), ['auto', 'new']);
  assert.ok(h.notes.some(n => n.msg === 'clase: parche 1:20–1:22 colocado en la pista A3 en 1:20.6.'),
    h.notes.map(n => n.msg).join(' | '));
});

test('a reprocessed class gets a bin name of its own too', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  await h.queue.run([h.queue.upsert({ id: '1', name: 'clase' })], PRESET);
  await h.queue.run([h.queue.upsert({ id: '1', name: 'clase' })], PRESET);
  assert.deepEqual(h.calls.filter(c => c.name === 'rename').map(c => c.newName),
    ['clase · Audio Pro', 'clase_2 · Audio Pro']);
});

test('an In→Out can run while the whole class is still running', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const whole = h.queue.upsert({ id: 'seq1', name: 'clase' });
  const wholeRun = h.queue.run([whole], PRESET);
  // The whole-class row is busy, so "Secuencia activa" would be refused...
  assert.equal(h.queue.upsert({ id: 'seq1', name: 'clase' }), null);
  // ...but a patch is a different row and goes ahead.
  const patch = h.queue.addInOut({ id: 'seq1', name: 'clase' }, { in: 10, out: 12 });
  const res = await h.queue.run([patch], PRESET);
  await wholeRun;
  assert.equal(res.done, 1);
  assert.equal(whole.stage, STAGE.DONE);
});

test('In→Out rows survive a reload with their region and sequence', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  h.queue.attach(dir);
  const patch = h.queue.addInOut({ id: 'seq1', name: 'clase' }, { in: 10, out: 12 });
  const [restored] = harness({ projectDir: dir }).queue.attach(dir);
  assert.equal(restored.id, patch.id);
  assert.equal(restored.seqId, 'seq1');
  assert.deepEqual(restored.region, { in: 10, out: 12 });
});

test('lanes bound how much runs at once, which is what keeps Premiere usable', async () => {
  const lane = queueMod.createLane(2);
  let peak = 0;
  let active = 0;
  const job = async () => lane.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
  });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
  assert.equal(lane.active, 0);
});

test('a lane hands a freed slot to the next waiter, so a newcomer cannot slip in', async () => {
  const lane = queueMod.createLane(1);
  let active = 0;
  let peak = 0;
  const job = () => lane.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
  });
  const first = job();
  const second = job();               // waits
  await first;
  const third = job();                // arrives the moment the first frees its slot
  await Promise.all([second, third]);
  assert.equal(peak, 1);
});

test('orphan cleanup only kills ffmpeg it recorded, on this machine', async () => {
  // A real child process standing in for an orphaned ffmpeg.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  await new Promise(resolve => child.once('spawn', resolve));
  try {
    const entry = { pid: child.pid, host: os.hostname(), cmd: process.execPath };

    // The queue file travels with the project: an entry from another Mac
    // names a pid that means nothing here.
    assert.equal(queueMod.isOurFfmpeg({ ...entry, host: 'otra-mac' }), false);
    // Same pid, different binary: pids get reused.
    assert.equal(queueMod.isOurFfmpeg({ ...entry, cmd: '/opt/otro/ffmpeg' }), false);
    // The bare pid numbers older queue files held carry neither, so are left alone.
    assert.equal(queueMod.killOrphans([child.pid]), 0);

    assert.equal(queueMod.isOurFfmpeg(entry), true);
    assert.equal(queueMod.killOrphans([entry]), 1);
    await new Promise(resolve => child.once('exit', resolve));
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
});
