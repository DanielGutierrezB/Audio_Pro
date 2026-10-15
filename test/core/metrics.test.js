'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const metrics = require('../../plugin/core/metrics');
const fx = require('./fixtures');

let workDir;
const files = {};

function codes(qc) { return qc.flags.map(f => f.code); }

before(async () => {
  workDir = fx.tmpDir('metrics');
  files.clean        = await fx.buildClean(path.join(workDir, 'clean.wav'));
  files.noisy         = await fx.buildNoisy(path.join(workDir, 'noisy.wav'));
  files.hum           = await fx.buildHum(path.join(workDir, 'hum.wav'), workDir);
  files.sibilant      = await fx.buildSibilant(path.join(workDir, 'sibilant.wav'), workDir);
  files.clipped       = await fx.buildClipped(path.join(workDir, 'clipped.wav'), workDir);
  files.noair         = await fx.buildNoAir(path.join(workDir, 'noair.wav'), workDir);
  files.squashed      = await fx.buildSquashed(path.join(workDir, 'squashed.wav'));
  files.silenceEdges  = await fx.buildSilenceEdges(path.join(workDir, 'silence-edges.wav'), workDir);
  files.dcOffset      = await fx.buildDcOffset(path.join(workDir, 'dc-offset.wav'), workDir);
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('clean fixture produces zero flags (no false positives)', async () => {
  const qc = await metrics.analyzeFile(files.clean);
  assert.deepEqual(codes(qc), []);
});

test('elevated noise floor during pauses raises NOISY', async () => {
  const qc = await metrics.analyzeFile(files.noisy);
  assert.ok(codes(qc).includes('NOISY'), `expected NOISY, got ${codes(qc)}`);
});

test('60 Hz mains tone raises HUM', async () => {
  const qc = await metrics.analyzeFile(files.hum);
  assert.ok(codes(qc).includes('HUM'), `expected HUM, got ${codes(qc)}`);
  const humFlag = qc.flags.find(f => f.code === 'HUM');
  assert.equal(humFlag.hz, 60);
});

test('boosted 5-9 kHz band raises SIBILANT', async () => {
  const qc = await metrics.analyzeFile(files.sibilant);
  assert.ok(codes(qc).includes('SIBILANT'), `expected SIBILANT, got ${codes(qc)}`);
});

test('hard-driven signal raises CLIP', async () => {
  const qc = await metrics.analyzeFile(files.clipped);
  assert.ok(codes(qc).includes('CLIP'), `expected CLIP, got ${codes(qc)}`);
});

test('lowpassed source raises NO_AIR', async () => {
  const qc = await metrics.analyzeFile(files.noair);
  assert.ok(codes(qc).includes('NO_AIR'), `expected NO_AIR, got ${codes(qc)}`);
  assert.ok(qc.bands.air - qc.bands.presence < metrics.QC_THRESHOLDS.airRatioDb);
});

// Both of these used to fire on material that is neither sibilant nor dull,
// which is how a near-constant 18 dB cut at 6.5 kHz went unnoticed: the
// thresholds were calibrated on broadband synthetic signals, then met real
// speech. See QC_THRESHOLDS in src/metrics.js for the measured ranges.
test('an elevated noise floor is not mistaken for sibilance', async () => {
  const qc = await metrics.analyzeFile(files.noisy);
  assert.ok(!codes(qc).includes('SIBILANT'), `expected no SIBILANT, got ${codes(qc)}`);
});

test('full-bandwidth material is never reported as band-limited', async () => {
  for (const name of ['clean', 'noisy', 'squashed']) {
    const qc = await metrics.analyzeFile(files[name]);
    assert.ok(!codes(qc).includes('NO_AIR'), `${name}: expected no NO_AIR, got ${codes(qc)}`);
  }
});

test('flat continuous level raises FLAT_DYNAMICS', async () => {
  const qc = await metrics.analyzeFile(files.squashed);
  assert.ok(codes(qc).includes('FLAT_DYNAMICS'), `expected FLAT_DYNAMICS, got ${codes(qc)}`);
});

test('padded head/tail silence is detected with the right durations', async () => {
  const qc = await metrics.analyzeFile(files.silenceEdges);
  const head = qc.flags.find(f => f.code === 'SILENCE_HEAD');
  const tail = qc.flags.find(f => f.code === 'SILENCE_TAIL');
  assert.ok(head, 'expected SILENCE_HEAD');
  assert.ok(tail, 'expected SILENCE_TAIL');
  assert.ok(Math.abs(head.end - 2.0) < 0.2, `head end ${head.end} should be ~2.0s`);
  assert.ok(tail.start > 0, 'tail start should be positive');
});

test('DC bias raises DC_OFFSET', async () => {
  const qc = await metrics.analyzeFile(files.dcOffset);
  assert.ok(codes(qc).includes('DC_OFFSET'), `expected DC_OFFSET, got ${codes(qc)}`);
});

test('denoiseMixFor scales with noise floor and floors at 0 for clean material', () => {
  assert.equal(metrics.denoiseMixFor(null), 0);
  assert.equal(metrics.denoiseMixFor(-70), 0);
  const light = metrics.denoiseMixFor(-49);
  const heavy = metrics.denoiseMixFor(-20);
  assert.ok(light > 0 && light <= 1, `light mix ${light} should be in (0,1]`);
  assert.ok(heavy > light, `heavier noise (${heavy}) should mix harder than light noise (${light})`);
});
