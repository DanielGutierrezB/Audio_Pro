'use strict';

// Integration smoke test: runs the real pipeline (no mocks) against small
// synthetic fixtures for both entry modes. Confirms the whole chain —
// analyze → conditional repair/denoise → tone/dynamics → loudness →
// render → verify — completes without throwing and produces a valid,
// duration-matched output file. Detector calibration itself is covered
// by test/metrics.test.js; this file is about wiring, not thresholds.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pipeline = require('../../plugin/core/pipeline');
const { runFfprobe } = require('../../plugin/core/ffmpeg-run');
const fx = require('./fixtures');

let workDir;

before(() => {
  workDir = fx.tmpDir('pipeline');
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

async function probeDuration(p) {
  const out = await runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_format', p]);
  return parseFloat(JSON.parse(out).format.duration);
}

function collector() {
  const events = [];
  return { events, emit: (type, data) => events.push({ type, ...data }) };
}

function baseRunOpts(extra) {
  return { isCancelled: () => false, setCurrent: () => {}, ...extra };
}

test('Mode 1 (original only): full chain renders a valid, duration-matched file', async () => {
  const src = await fx.buildClean(path.join(workDir, 'mode1-src.wav'));
  const outDir = path.join(workDir, 'mode1-out');
  const { events, emit } = collector();

  await pipeline.processQueue([{ path: src }], {
    emit, ...baseRunOpts(),
    settings: { customOutputDir: outDir, platformPreset: 'platzi' },
  });

  const done = events.find(e => e.type === 'file:done');
  const errored = events.find(e => e.type === 'file:error');
  assert.equal(errored, undefined, `unexpected error: ${errored?.error}`);
  assert.ok(done, 'expected a file:done event');
  assert.equal(done.mode, 1);
  assert.ok(fs.existsSync(done.outputPath));

  const [srcDur, outDur] = await Promise.all([probeDuration(src), probeDuration(done.outputPath)]);
  assert.ok(Math.abs(srcDur - outDur) < 0.2, `output duration ${outDur} should track source ${srcDur}`);

  const qcEvent = events.find(e => e.type === 'qc');
  assert.ok(qcEvent, 'expected a qc event with input flags');
  assert.equal(qcEvent.mode, 1);

  const batchDone = events.find(e => e.type === 'batch:done');
  assert.ok(batchDone && batchDone.done === 1 && batchDone.total === 1);
});

test('Mode 2 (original + Adobe 100%): pairs, fuses, then renders', async () => {
  const dir = path.join(workDir, 'mode2');
  fs.mkdirSync(dir, { recursive: true });
  const original = await fx.buildTone(path.join(dir, 'clase.wav'), { duration: 4, frequency: 170, peakDb: -18 });
  const enhanced = await fx.buildTone(path.join(dir, 'clase-enhanced.wav'), { duration: 4, frequency: 170, peakDb: -22 });
  const outDir = path.join(workDir, 'mode2-out');
  const { events, emit } = collector();

  await pipeline.processQueue([{ path: original, pairPath: enhanced }], {
    emit, ...baseRunOpts(),
    settings: { customOutputDir: outDir, platformPreset: 'youtube', fusionMode: 'bands' },
  });

  const done = events.find(e => e.type === 'file:done');
  const errored = events.find(e => e.type === 'file:error');
  assert.equal(errored, undefined, `unexpected error: ${errored?.error}`);
  assert.ok(done, 'expected a file:done event');
  assert.equal(done.mode, 2);
  assert.ok(fs.existsSync(done.outputPath));

  const outDur = await probeDuration(done.outputPath);
  assert.ok(Math.abs(outDur - 4) < 0.2, `output duration ${outDur} should track the 4s pair`);
});

test('Mismatched pair durations fall back to Mode 1 on the original', async () => {
  const dir = path.join(workDir, 'mode2-mismatch');
  fs.mkdirSync(dir, { recursive: true });
  const original = await fx.buildTone(path.join(dir, 'clase.wav'), { duration: 5, frequency: 170, peakDb: -18 });
  const enhanced = await fx.buildTone(path.join(dir, 'clase-enhanced.wav'), { duration: 2, frequency: 170, peakDb: -22 });
  const outDir = path.join(workDir, 'mode2-mismatch-out');
  const { events, emit } = collector();

  await pipeline.processQueue([{ path: original, pairPath: enhanced }], {
    emit, ...baseRunOpts(),
    settings: { customOutputDir: outDir },
  });

  const done = events.find(e => e.type === 'file:done');
  assert.ok(done, 'expected a file:done event');
  assert.equal(done.mode, 1, 'an unusable pair should degrade to Mode 1');

  // The degrade must be visible on the file row, not just in the log: the user
  // paid Adobe credits for a pass that is being thrown away here.
  const qc = events.find(e => e.type === 'qc');
  assert.ok(qc, 'expected a qc event');
  assert.ok(qc.flags.some(f => f.code === 'PAIR_MISMATCH'),
    `expected PAIR_MISMATCH, got ${qc.flags.map(f => f.code)}`);
});

test('Cancellation mid-batch stops before the second file starts', async () => {
  const src1 = await fx.buildTone(path.join(workDir, 'cancel-1.wav'), { duration: 2 });
  const src2 = await fx.buildTone(path.join(workDir, 'cancel-2.wav'), { duration: 2 });
  const outDir = path.join(workDir, 'cancel-out');
  let cancelled = false;
  const events = [];
  const emit = (type, data) => {
    events.push({ type, ...data });
    // Cancel as soon as the first file finishes so the worker's next
    // isCancelled() check (before file 2's file:start) short-circuits it.
    if (type === 'file:done' || type === 'file:error') cancelled = true;
  };

  await pipeline.processQueue([{ path: src1 }, { path: src2 }], {
    emit,
    isCancelled: () => cancelled,
    setCurrent: () => {},
    // Pinned to one worker: this is about cancellation claiming no further
    // work, not about the pool. With N workers up to N files are already in
    // flight when the cancel lands, which concurrency.test.js covers instead.
    settings: { customOutputDir: outDir, concurrency: 1 },
  });

  const starts = events.filter(e => e.type === 'file:start');
  assert.equal(starts.length, 1, 'second file should never have started once cancelled');
  const batchDone = events.find(e => e.type === 'batch:done');
  assert.ok(batchDone);
});
