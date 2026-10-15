'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DELIVERY_PRESETS, DEFAULT_PRESET, getPreset } = require('../../plugin/core/presets');

test('every preset declares integrated loudness, true peak and LRA targets', () => {
  for (const [id, preset] of Object.entries(DELIVERY_PRESETS)) {
    assert.equal(typeof preset.i, 'number', `${id}.i`);
    assert.equal(typeof preset.tp, 'number', `${id}.tp`);
    assert.equal(typeof preset.lra, 'number', `${id}.lra`);
    assert.ok(preset.tp < 0, `${id}.tp should be a headroom below 0 dBTP`);
  }
});

test('getPreset falls back to the default for unknown ids', () => {
  assert.deepEqual(getPreset('does-not-exist'), DELIVERY_PRESETS[DEFAULT_PRESET]);
  assert.deepEqual(getPreset(undefined), DELIVERY_PRESETS[DEFAULT_PRESET]);
});

test('getPreset resolves known platform ids', () => {
  assert.equal(getPreset('youtube').i, -14);
  assert.equal(getPreset('platzi').i, -16);
  assert.equal(getPreset('podcast').i, -16);
  assert.equal(getPreset('podcast').tp, -1.0);
});
