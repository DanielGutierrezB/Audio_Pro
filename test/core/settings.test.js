'use strict';

// Settings validation is a trust boundary, not a convenience check: every
// value arrives from the renderer over IPC, `manualEqChain` is spliced
// straight into an FFmpeg filter graph, and `customOutputDir` becomes a write
// target. It lived inline in main.js and so could not be tested at all.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const settings = require('../../plugin/core/settings');
const { DELIVERY_PRESETS } = require('../../plugin/core/presets');

test('only declared keys are accepted', () => {
  assert.equal(settings.validate('hpfFrequency', 100), true);
  assert.equal(settings.validate('somethingInvented', 1), false);
  assert.equal(settings.validate('__proto__', {}), false);
  assert.equal(settings.validate('', 1), false);
  for (const key of [null, undefined, 42, {}]) {
    assert.equal(settings.validate(key, 1), false);
  }
});

test('every default is itself valid — the shipped state cannot be rejected', () => {
  for (const [key, value] of Object.entries(settings.DEFAULTS)) {
    assert.equal(settings.validate(key, value), true, `${key}=${JSON.stringify(value)} was rejected`);
  }
});

test('types are enforced per key', () => {
  assert.equal(settings.validate('deEsserEnabled', true), true);
  assert.equal(settings.validate('deEsserEnabled', 'true'), false);
  assert.equal(settings.validate('deEsserEnabled', 1), false);

  assert.equal(settings.validate('outputFormat', 'flac'), true);
  assert.equal(settings.validate('outputFormat', 24), false);

  assert.equal(settings.validate('hpfFrequency', 80), true);
  assert.equal(settings.validate('hpfFrequency', '80'), false);
  assert.equal(settings.validate('hpfFrequency', NaN), false);
  assert.equal(settings.validate('hpfFrequency', Infinity), false);
});

test('enums only take the values the pipeline knows how to read', () => {
  for (const preset of Object.keys(DELIVERY_PRESETS)) {
    assert.equal(settings.validate('platformPreset', preset), true);
  }
  assert.equal(settings.validate('platformPreset', 'spotify'), false);
  assert.equal(settings.validate('fusionMode', 'bands_bed'), true);
  assert.equal(settings.validate('fusionMode', 'sidechain'), false);
  assert.equal(settings.validate('normalizeMode', 'raiseOnly'), true);
  assert.equal(settings.validate('denoiseMode', 'aggressive'), false,
    'a preset that does not exist must not reach the pipeline');
});

test('ranges are clamped at both ends', () => {
  for (const [key, [lo, hi]] of Object.entries(settings.RANGE_VALUES)) {
    assert.equal(settings.validate(key, lo), true, `${key} should accept its minimum`);
    assert.equal(settings.validate(key, hi), true, `${key} should accept its maximum`);
    assert.equal(settings.validate(key, lo - 1), false, `${key} accepted below its minimum`);
    assert.equal(settings.validate(key, hi + 1), false, `${key} accepted above its maximum`);
  }
});

// This is the one that matters most: the string goes into an FFmpeg filter
// graph. FFmpeg is spawned without a shell, so these are not shell
// metacharacters in the usual sense, but they are what lets an expression
// break out of its own filter — and a newline would smuggle in a second graph.
test('the manual EQ chain rejects anything that could break the filter graph', () => {
  assert.equal(settings.validate('manualEqChain', 'equalizer=f=150:width_type=q:width=2:g=-3'), true);
  assert.equal(settings.validate('manualEqChain', ''), true);

  for (const bad of ['`whoami`', '$(id)', 'a;b', 'a&b', 'a|b', 'a<b', 'a>b', 'a\\b', 'a\nb', 'a\rb']) {
    assert.equal(settings.validate('manualEqChain', bad), false, `accepted ${JSON.stringify(bad)}`);
  }

  assert.equal(settings.validate('manualEqChain', 'a'.repeat(settings.MAX_EQ_CHAIN_LENGTH)), true);
  assert.equal(settings.validate('manualEqChain', 'a'.repeat(settings.MAX_EQ_CHAIN_LENGTH + 1)), false);
});

test('the output directory must be an absolute path with no traversal', () => {
  assert.equal(settings.validate('customOutputDir', '/Users/me/Audio_Pro'), true);
  assert.equal(settings.validate('customOutputDir', ''), true, 'empty means "next to the source"');
  assert.equal(settings.validate('customOutputDir', 'relative/path'), false);
  assert.equal(settings.validate('customOutputDir', '/Users/me/../../etc'), false);
  assert.equal(settings.validate('customOutputDir', '/' + 'a'.repeat(settings.MAX_PATH_LENGTH)), false);
});

test('pipelineSettings reads every key the render depends on', () => {
  const reads = [];
  const store = {
    get: (k) => { reads.push(k); return settings.DEFAULTS[k]; },
  };
  const out = settings.pipelineSettings(store);

  // Anything the pipeline branches on must be present, or a stage silently
  // takes its fallback instead of the user's setting.
  for (const key of [
    'platformPreset', 'outputFormat', 'sampleRate', 'manualEqApply', 'manualEqChain',
    'denoiseMode', 'compressionMode', 'bodyPct', 'deEsserAmount', 'airExtraAmount',
    'adaptiveToneEnabled', 'toneTiltTarget', 'trimSilence', 'normalizeMode',
    'fusionEnabled', 'fusionMode', 'fusionCrossoverHz', 'fusionOriginalPct',
  ]) {
    assert.ok(reads.includes(key), `pipelineSettings never read ${key}`);
    assert.ok(key in out, `pipelineSettings did not pass ${key} through`);
  }
});

test('a concurrency of 0 reaches the pipeline as "decide for me", not zero workers', () => {
  const store = { get: (k) => (k === 'concurrency' ? 0 : settings.DEFAULTS[k]) };
  assert.equal(settings.pipelineSettings(store).concurrency, undefined);

  const pinned = { get: (k) => (k === 'concurrency' ? 2 : settings.DEFAULTS[k]) };
  assert.equal(settings.pipelineSettings(pinned).concurrency, 2);
});
