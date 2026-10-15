'use strict';

// The settings file is hand-editable and survives updates, so it is untrusted
// input like anything else: `customOutputDir` becomes a write target and
// `manualEqChain` would be spliced into an ffmpeg filter graph. These tests
// are about what the panel refuses to store and what it always sends.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('../plugin/js/settings');

function withTempHome(fn) {
  const previous = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-settings-'));
  process.env.HOME = home;
  try { return fn(home); } finally { process.env.HOME = previous; }
}

test('the defaults are all valid, so the shipped state cannot be rejected', () => {
  const d = settings.defaults();
  for (const [key, value] of Object.entries(d)) {
    assert.ok(settings.accepts(key, value), `default ${key}=${value} was rejected`);
  }
  assert.equal(d.platformPreset, 'platzi');
  assert.equal(d.fusionOriginalPct, 20);
  assert.equal(d.labelInProgress, 7, 'Mango');
  assert.equal(d.labelDone, 13, 'Verde');
});

test('only the exposed keys are accepted', () => {
  assert.ok(settings.accepts('platformPreset', 'youtube'));
  assert.ok(settings.accepts('fusionOriginalPct', 30));
  // Not exposed: changing these from the UI would break the Premiere path.
  assert.equal(settings.accepts('trimSilence', true), false);
  assert.equal(settings.accepts('skipUnchanged', true), false);
  assert.equal(settings.accepts('customOutputDir', '/tmp/anywhere'), false);
  assert.equal(settings.accepts('manualEqChain', 'highpass=f=80'), false);
  assert.equal(settings.accepts('inventado', 1), false);
});

test('values outside the core\'s own ranges are rejected', () => {
  assert.equal(settings.accepts('fusionOriginalPct', 80), false, 'the bed is capped at 40%');
  assert.equal(settings.accepts('toneTiltTarget', 40), false);
  assert.equal(settings.accepts('platformPreset', 'spotify'), false);
  assert.equal(settings.accepts('fusionMode', 'magic'), false);
});

test('colour labels have to be a real Premiere label', () => {
  assert.ok(settings.accepts('labelDone', 0));
  assert.ok(settings.accepts('labelDone', 15));
  assert.equal(settings.accepts('labelDone', 16), false);
  assert.equal(settings.accepts('labelDone', -1), false);
  assert.equal(settings.accepts('labelDone', '7'), false, 'a string would reach setColorLabel as NaN');
});

test('a hand-edited settings file keeps what is valid and drops the rest', () => {
  withTempHome(() => {
    fs.mkdirSync(path.dirname(settings.settingsFile()), { recursive: true });
    fs.writeFileSync(settings.settingsFile(), JSON.stringify({
      platformPreset: 'youtube',       // fine
      fusionOriginalPct: 999,          // out of range
      trimSilence: true,               // not ours to change — this one desyncs
      customOutputDir: '/etc',         // not settable from here
      labelDone: 5,                    // fine
    }));

    const loaded = settings.load();
    assert.equal(loaded.platformPreset, 'youtube');
    assert.equal(loaded.labelDone, 5);
    assert.equal(loaded.fusionOriginalPct, 20, 'fell back to the default');
    assert.equal(loaded.trimSilence, undefined, 'never reaches the panel state');
    assert.equal(loaded.customOutputDir, undefined);
  });
});

test('a corrupt settings file is ignored rather than fatal', () => {
  withTempHome(() => {
    fs.mkdirSync(path.dirname(settings.settingsFile()), { recursive: true });
    fs.writeFileSync(settings.settingsFile(), 'not json at all');
    assert.deepEqual(settings.load(), settings.defaults());
  });
});

test('saving round-trips and silently drops what it will not store', () => {
  withTempHome(() => {
    const res = settings.save({ platformPreset: 'podcast', toneTiltTarget: 12, trimSilence: true });
    assert.ok(res.ok);
    assert.deepEqual(res.saved, { platformPreset: 'podcast', toneTiltTarget: 12 });
    const loaded = settings.load();
    assert.equal(loaded.platformPreset, 'podcast');
    assert.equal(loaded.toneTiltTarget, 12);
  });
});

test('what reaches the pipeline always carries the three non-negotiables', () => {
  const out = settings.pipelineSettings(settings.defaults(), { outputDir: '/p/Audio_Process/Audio_Pro' });

  // trimSilence: atrim shifts the audio earlier and desyncs the timeline.
  assert.equal(out.trimSilence, false);
  // skipUnchanged: each run exports to a new path, and a "skipped" file would
  // leave the clip stuck in the in-progress colour forever.
  assert.equal(out.skipUnchanged, false);
  // customOutputDir: otherwise the master lands in a sibling of the export
  // rather than in Audio_Process/Audio_Pro.
  assert.equal(out.customOutputDir, '/p/Audio_Process/Audio_Pro');
  assert.equal(out.concurrency, 1);
  assert.equal(out.normalizeMode, 'both');
});

test('an In→Out run only ever raises the level', () => {
  const out = settings.pipelineSettings(settings.defaults(), { outputDir: '/p', inOut: true });
  // Normalising a 20-second excerpt to -16 LUFS normalises *that excerpt*,
  // which may be nothing like the sequence it came from.
  assert.equal(out.normalizeMode, 'raiseOnly');
});

test('the panel-only keys never leak into the pipeline settings', () => {
  const out = settings.pipelineSettings(
    { ...settings.defaults(), muteOthers: false, labelDone: 3 },
    { outputDir: '/p' },
  );
  assert.equal(out.muteOthers, undefined);
  assert.equal(out.labelDone, undefined);
});
