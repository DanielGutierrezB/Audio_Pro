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

const queueMod = require('../plugin/js/queue');
const { STAGE } = queueMod;

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-queue-'));
}

function touch(filePath, bytes = 'wav') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

// A harness that records the order of everything and lets each stage be made
// to fail on demand.
function harness(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };

  const host = {
    exportAudio: async (id, outPath) => {
      calls.push({ name: 'export', id, outPath });
      if (overrides.exportFails) return { ok: false, error: 'NO_PRESET' };
      touch(outPath);
      return { ok: true, outPath, inPoint: overrides.inPoint ?? 0 };
    },
    placeEnhanced: async (id, wavPath, mute, start, label) => {
      calls.push({ name: 'place', id, wavPath, mute, start, label });
      if (overrides.placeFails) return { ok: false, error: 'no encontré pista vacía' };
      return { ok: true, nodeId: 'node-' + id, track: 2 };
    },
    relinkMaster: async (nodeId, masterPath, label) => {
      calls.push({ name: 'relink', nodeId, masterPath, label });
      if (overrides.relinkFails) return { ok: false, error: 'changeMediaPath falló' };
      return { ok: true, path: masterPath };
    },
    renameItem: async (nodeId, name) => { calls.push({ name: 'rename', nodeId, newName: name }); return { ok: true }; },
    setLabel: record('setLabel'),
    getProjectDir: async () => ({ ok: true, dir: overrides.projectDir }),
    getOpenSequences: async () => ({ ok: true, sequences: overrides.sequences || [] }),
    getActiveSequence: async () => ({ ok: true, id: '1', name: 'clase' }),
  };

  const phonos = {
    enhanceToFile: async (inPath, outPath) => {
      calls.push({ name: 'adobe', inPath, outPath });
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
    getToken: () => 'tok',
    hasToken: () => true,
    limitState: () => limit,
    armLimit: (secs) => { calls.push({ name: 'armLimit', secs }); limit.limited = true; },
    trySilentReauth: async () => {
      calls.push({ name: 'reauth' });
      return overrides.reauthWorks ? 'fresh' : null;
    },
  };

  const notes = [];
  const queue = queueMod.createQueue({
    host,
    phonos,
    aligner,
    mastering,
    session,
    getSettings: () => ({
      muteOthers: true,
      labelInProgress: 7,
      labelDone: 13,
      platformPreset: 'platzi',
    }),
    pipelineSettings: (s, { outputDir, inOut }) => ({
      trimSilence: false,
      skipUnchanged: false,
      normalizeMode: inOut ? 'raiseOnly' : 'both',
      customOutputDir: outputDir,
      platformPreset: s.platformPreset,
    }),
    log: () => {},
    notify: (msg, type) => notes.push({ msg, type }),
  });

  return { queue, calls, notes, names: () => calls.map(c => c.name), limit };
}

test('the happy path runs the six stages in order and ends on the master', async () => {
  const dir = tmpProject();
  const { queue, calls, names } = harness({ projectDir: dir });
  await queue.attach(dir);
  const item = queue.upsert({ id: '1', name: 'clase 01' });

  const res = await queue.process([item], { presetPath: '/preset.epr' });

  assert.equal(res.ok, 1);
  assert.deepEqual(names(), ['export', 'adobe', 'align', 'place', 'master', 'relink', 'rename']);
  assert.equal(item.stage, STAGE.DONE);
  assert.equal(item.nodeId, 'node-1');
  assert.equal(item.mode, 2);

  // The clip goes on the timeline in the in-progress colour and only turns to
  // the done colour at the relink — that transition is the whole user-visible
  // contract of the two-stage flow.
  assert.equal(calls.find(c => c.name === 'place').label, 7);
  assert.equal(calls.find(c => c.name === 'relink').label, 13);
});

test('what lands on disk follows the Audio_Process layout', async () => {
  const dir = tmpProject();
  const { queue, calls } = harness({ projectDir: dir });
  await queue.attach(dir);
  const item = queue.upsert({ id: '7', name: 'clase 02' });
  await queue.process([item], { presetPath: '/preset.epr' });

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

  // Adobe gets the original and the chain gets the *aligned* enhanced file,
  // never the raw return.
  assert.equal(master.enhancedPath, item.paths.enhanced);
});

test('an In→Out run normalises raiseOnly and never mutes the other tracks', async () => {
  const dir = tmpProject();
  const { queue, calls } = harness({ projectDir: dir, inPoint: 12.5 });
  await queue.attach(dir);
  const item = queue.upsert({ id: '3', name: 'clase' }, { workArea: 1 });
  await queue.process([item], { presetPath: '/preset.epr' });

  const place = calls.find(c => c.name === 'place');
  // Muting silences a whole track, which outside the region would kill the
  // rest of the timeline.
  assert.equal(place.mute, 0);
  // The clip starts at the In point so it lines up with what was processed.
  assert.equal(place.start, '12.5');
  assert.equal(calls.find(c => c.name === 'master').settings.normalizeMode, 'raiseOnly');
  assert.match(item.paths.original, /clase_inout\.wav$/);
});

test('a failed master leaves the clip placed and offers a retry that costs no credits', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, masterFails: true });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.equal(item.stage, STAGE.ERROR);
  assert.equal(item.nodeId, 'node-1', 'the clip is still on the timeline');
  assert.ok(item.canRetryMaster, 'the row offers a retry');
  assert.ok(!h.names().includes('relink'), 'nothing was relinked');

  // Retrying re-runs only the master: no export, no Adobe, no second clip.
  h.calls.length = 0;
  h.queue.get('1').error = null;
  const retry = await h.queue.retryMaster('1', { presetPath: '/preset.epr' });
  assert.equal(retry.failed, 1);
  assert.deepEqual(h.names(), ['master'], 'only the master stage re-ran');
});

test('mode 1 means the Adobe pass was dropped, so the clip is not relinked', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, mode: 1 });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.ok(!h.names().includes('relink'));
  assert.equal(item.stage, STAGE.ERROR);
  assert.equal(item.note, 'PAIR_MISMATCH');
  assert.ok(h.notes.some(n => /par con Adobe/.test(n.msg)));
});

test('a master whose length drifted from the original is never relinked', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, drift: 3.2 });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.ok(!h.names().includes('relink'), 'relinking would desync the sequence');
  assert.equal(item.note, 'SYNC');
});

test('a verify warning still relinks — it is a note, not a veto', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, verify: { i: -15.1, tp: -2.0, badge: 'warn' } });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.ok(h.names().includes('relink'));
  assert.equal(item.stage, STAGE.DONE);
  assert.match(item.status, /-15\.1/);
});

test('a pair that could not be aligned is placed but not mastered unattended', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, alignNote: 'PAIR?' });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  const res = await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.deepEqual(h.names(), ['export', 'adobe', 'align', 'place']);
  assert.equal(item.stage, STAGE.PLACED, 'still resumable: the editor can master it after looking');
  assert.equal(res.ok, 1);
});

test('an export failure stops before a single credit is spent', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir, exportFails: true });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.deepEqual(h.names(), ['export']);
  assert.equal(item.stage, STAGE.ERROR);
  assert.match(item.error, /preset/);
});

test('a credits limit arms the shared gate and leaves the row pending, not failed', async () => {
  const dir = tmpProject();
  const h = harness({
    projectDir: dir,
    adobeError: () => Object.assign(new Error('sin créditos'), { code: 'LIMIT', retrySeconds: 90 }),
  });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.ok(h.calls.some(c => c.name === 'armLimit' && c.secs === 90));
  // Pending rather than error: nothing is wrong with this sequence, Adobe is
  // just unavailable for an hour, and it should resume without being re-added.
  assert.equal(item.stage, STAGE.PENDING);
});

test('a 401 is retried once behind a silent reauth', async () => {
  const dir = tmpProject();
  let thrown = 0;
  const h = harness({
    projectDir: dir,
    reauthWorks: true,
    adobeError: () => (thrown++ === 0 ? Object.assign(new Error('401'), { code: 'AUTH' }) : undefined),
  });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });

  await h.queue.process([item], { presetPath: '/preset.epr' });

  assert.deepEqual(h.names(), [
    'export', 'adobe', 'reauth', 'adobe', 'align', 'place', 'master', 'relink', 'rename',
  ]);
  assert.equal(h.calls.filter(c => c.name === 'adobe').length, 2, 'the same file is retried');
  assert.equal(h.calls.filter(c => c.name === 'reauth').length, 1);
  assert.equal(item.stage, STAGE.DONE);
});

test('reprocessing writes _2 instead of overwriting a file the timeline points at', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  await h.queue.attach(dir);

  const first = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.process([first], { presetPath: '/preset.epr' });
  const firstPaths = { ...first.paths };

  const second = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.process([second], { presetPath: '/preset.epr' });

  assert.equal(second.runIndex, 2);
  assert.match(second.paths.original, /clase_2\.wav$/);
  assert.notEqual(second.paths.original, firstPaths.original);
  assert.ok(fs.existsSync(firstPaths.original), 'the first run survives untouched');
});

test('the queue file survives a reload and resumes from the right stage', async () => {
  const dir = tmpProject();
  const h = harness({ projectDir: dir });
  await h.queue.attach(dir);
  const item = h.queue.upsert({ id: '1', name: 'clase' });
  await h.queue.process([item], { presetPath: '/preset.epr' });

  const queueFile = path.join(dir, 'Audio_Process', 'queue.json');
  const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.equal(saved.version, queueMod.QUEUE_VERSION);
  assert.equal(saved.items[0].stage, STAGE.DONE);

  // Rewrite it as if the panel had died while mastering, then reattach.
  saved.items[0].stage = STAGE.MASTERING;
  fs.writeFileSync(queueFile, JSON.stringify(saved));

  const fresh = harness({ projectDir: dir });
  const restored = await fresh.queue.attach(dir);
  assert.equal(restored[0].stage, STAGE.MASTERING, 'both intermediates are on disk, so it resumes at the master');

  fresh.calls.length = 0;
  await fresh.queue.process(fresh.queue.pending(), { presetPath: '/preset.epr' });
  assert.deepEqual(fresh.names(), ['master', 'relink', 'rename'], 'no export, and no credits spent again');
});

test('a resume whose intermediates are gone starts over instead of mastering nothing', async () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify({
    version: queueMod.QUEUE_VERSION,
    items: [{
      id: '1', name: 'clase', stage: STAGE.MASTERING,
      paths: {
        original: path.join(work, 'clase.wav'),
        enhanced: path.join(work, 'Enhanced', 'clase.wav'),
      },
    }],
  }));

  const h = harness({ projectDir: dir });
  const items = await h.queue.attach(dir);
  assert.equal(items[0].stage, STAGE.PENDING);
});

test('a resume that already has Adobe\'s return re-aligns instead of paying again', async () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  const raw = path.join(work, 'Enhanced', 'clase.raw.wav');
  touch(path.join(work, 'clase.wav'));
  touch(raw);
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify({
    version: queueMod.QUEUE_VERSION,
    items: [{
      id: '1', name: 'clase', stage: STAGE.ENHANCING, stem: 'clase',
      paths: {
        original: path.join(work, 'clase.wav'),
        enhancedRaw: raw,
        enhanced: path.join(work, 'Enhanced', 'clase.wav'),
        master: path.join(work, 'Audio_Pro', 'clase.wav'),
      },
    }],
  }));

  const h = harness({ projectDir: dir });
  const items = await h.queue.attach(dir);
  assert.equal(items[0].stage, STAGE.ALIGNING);

  await h.queue.process(h.queue.pending(), { presetPath: '/preset.epr' });
  assert.ok(!h.names().includes('adobe'), 'the credits were already spent on this file');
  assert.deepEqual(h.names(), ['align', 'place', 'master', 'relink', 'rename']);
});

test('a v1 queue from the Adobe Podcast panel is migrated, not discarded', async () => {
  const dir = tmpProject();
  const work = path.join(dir, 'Audio_Process');
  fs.mkdirSync(work, { recursive: true });
  // v1 was a bare array of { id, name, done }.
  fs.writeFileSync(path.join(work, 'queue.json'), JSON.stringify([
    { id: '10', name: 'clase 01', done: true },
    { id: '11', name: 'clase 02', done: false },
  ]));

  const h = harness({ projectDir: dir });
  const items = await h.queue.attach(dir);

  assert.equal(items.length, 2);
  assert.equal(items[0].stage, STAGE.DONE);
  assert.equal(items[1].stage, STAGE.PENDING);
  assert.equal(items[1].name, 'clase 02');
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

test('orphan cleanup refuses to kill a pid that is not one of ours', () => {
  // The current process is definitely not ffmpeg, so this must be left alone:
  // pids get reused, and killing a stranger's process is far worse than
  // leaving a stale entry in the queue file.
  assert.equal(queueMod.isOurFfmpeg(process.pid), false);
  assert.equal(queueMod.killOrphans([process.pid]), 0);
});
