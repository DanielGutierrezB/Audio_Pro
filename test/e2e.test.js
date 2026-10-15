'use strict';

// The whole panel minus Premiere and minus Adobe: the real queue, the real
// alignment, the real mastering chain and the real ffmpeg, with only the two
// things a test runner cannot have replaced by stand-ins. Every other test
// checks one piece; this is the one that checks they fit together — in
// particular that the sync fix survives the whole trip, since the place where
// a desync would come from (the pipeline) and the place it would be caught
// (the relink gate) are four modules apart.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const queueMod = require('../plugin/js/queue');
const aligner = require('../plugin/js/align-to-original');
const mastering = require('../plugin/js/mastering');
const panelSettings = require('../plugin/js/settings');
const { buildSpeechLike } = require('./speech-fixture');

const HEAD_SILENCE_SEC = 3;

let projectDir;
before(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-e2e-')); });
after(() => { if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true }); });

test('a sequence that starts in silence comes back mastered, in sync, and relinked', async () => {
  const relinks = [];

  // Premiere: the export is a take with three seconds of silence at the head,
  // which is exactly what desyncs a naive pipeline.
  const host = {
    exportAudio: async (id, outPath) => {
      await buildSpeechLike(outPath, { silenceHead: HEAD_SILENCE_SEC, duration: 8 });
      return { ok: true, outPath, inPoint: 0 };
    },
    placeEnhanced: async () => ({ ok: true, nodeId: 'node-1', track: 2 }),
    relinkMaster: async (nodeId, masterPath, label) => {
      relinks.push({ nodeId, masterPath, label });
      return { ok: true, path: masterPath };
    },
    renameItem: async () => ({ ok: true }),
  };

  // Adobe: hands back the same take with the leading silence trimmed off.
  const phonos = {
    enhanceToFile: async (inPath, outPath) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      await buildSpeechLike(outPath, { silenceHead: 0, duration: 8 });
      return { ok: true, outPath };
    },
  };

  const session = {
    getToken: () => 'tok',
    limitState: () => ({ limited: false }),
    armLimit: () => {},
    trySilentReauth: async () => null,
  };

  const queue = queueMod.createQueue({
    host, phonos, aligner, mastering, session,
    getSettings: () => panelSettings.defaults(),
    pipelineSettings: panelSettings.pipelineSettings,
  });
  queue.attach(projectDir);
  const item = queue.upsert({ id: '1', name: 'clase 01' });

  const res = await queue.run([item], { presetPath: '/preset.epr' });

  assert.equal(res.done, 1, item.error || 'the row failed');
  assert.equal(item.stage, queueMod.STAGE.DONE);
  assert.equal(item.alignNote, 'REALIGNED', 'Adobe\'s trimmed head was put back');

  // Mode 2 means the Adobe pass actually went into the master.
  assert.equal(item.mode, 2);
  assert.equal(item.verify.badge, 'ok', `loudness ${item.verify.i} LUFS`);

  // In sync: the master spans exactly what the sequence exported.
  const origDur = await aligner.durationOf(item.paths.original);
  const masterDur = await aligner.durationOf(item.paths.master);
  assert.ok(Math.abs(origDur - masterDur) < 0.05, `master ${masterDur}s vs original ${origDur}s`);

  // The clip was relinked to that master, in the done colour.
  assert.deepEqual(relinks, [{ nodeId: 'node-1', masterPath: item.paths.master, label: 13 }]);
  assert.equal(item.paths.master, path.join(projectDir, 'Audio_Process', 'Audio_Pro', 'clase 01.wav'));

  // And the sidecar says how it was made.
  const sidecar = JSON.parse(fs.readFileSync(item.paths.master.replace(/\.wav$/, '.json'), 'utf8'));
  assert.equal(sidecar.mode, 2);
  assert.match(sidecar.engine.ffmpeg, /^ffmpeg version [7-9]/);
  assert.equal(sidecar.settings.trimSilence, false);
});
