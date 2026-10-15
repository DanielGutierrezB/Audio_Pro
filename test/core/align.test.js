'use strict';

// Pair alignment. The behaviour being replaced: any Mode 2 pair whose
// durations differed by more than half a second dropped to Mode 1 on the
// original, with nothing but a log line — the Adobe pass the user spent
// credits on was thrown away silently. These tests cover recovering the
// offset, refusing when the files aren't the same take, and saying so either
// way.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const align = require('../../plugin/core/align');
const { runFfmpeg } = require('../../plugin/core/ffmpeg-run');
const fx = require('./fixtures');

let workDir;
const files = {};

// Same take, started `sec` later — what Adobe trimming the head looks like.
async function shiftedCopy(src, out, sec) {
  await runFfmpeg(['-y', '-i', src, '-af', `atrim=start=${sec},asetpts=PTS-STARTPTS`,
    '-ac', '1', '-ar', String(fx.SR), out], { timeout: 60000 });
  return out;
}

before(async () => {
  workDir = fx.tmpDir('align');
  // Long enough that a few seconds of offset still leaves plenty of overlap,
  // and varied enough that the envelope has shape to correlate on.
  files.original = await fx.buildSilenceEdges(path.join(workDir, 'original.wav'), workDir);
  files.shifted2s = await shiftedCopy(files.original, path.join(workDir, 'shift-2s.wav'), 2);
  files.other = await fx.buildTone(path.join(workDir, 'other.wav'), { duration: 8, frequency: 440 });
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('a known head trim is recovered with the right sign and magnitude', async () => {
  const r = await align.estimateOffset(files.original, files.shifted2s);
  assert.ok(r.confident, `expected confidence, got correlation ${r.correlation.toFixed(2)}`);
  // Positive = the enhanced file starts later in the take, so the original
  // carries the extra head. 10 ms resolution, so allow a couple of points.
  assert.ok(Math.abs(r.offsetSec - 2) < 0.1,
    `expected ~+2.00s, got ${r.offsetSec.toFixed(2)}s`);
});

test('the offset is antisymmetric — swapping the arguments flips the sign', async () => {
  const forward = await align.estimateOffset(files.original, files.shifted2s);
  const back = await align.estimateOffset(files.shifted2s, files.original);
  assert.ok(Math.abs(forward.offsetSec + back.offsetSec) < 0.1,
    `${forward.offsetSec.toFixed(2)} and ${back.offsetSec.toFixed(2)} should cancel`);
});

test('an identical pair reports no offset at full correlation', async () => {
  const r = await align.estimateOffset(files.original, files.original);
  assert.ok(Math.abs(r.offsetSec) < 0.02, `expected ~0s, got ${r.offsetSec}`);
  assert.ok(r.correlation > 0.99, `expected ~1.0, got ${r.correlation}`);
  assert.ok(r.confident);
});

test('two different recordings are refused rather than force-aligned', async () => {
  const r = await align.estimateOffset(files.original, files.other);
  assert.ok(!r.confident,
    `a plain tone should not pass as the same take (correlation ${r.correlation.toFixed(2)})`);
  assert.ok(r.correlation < align.MIN_CORRELATION);
});

test('renderShifted trims a head and prepends silence for a negative shift', async () => {
  const trimmed = await align.renderShifted(files.original, 1.5);
  const delayed = await align.renderShifted(files.original, -1.5);
  try {
    const dur = async (f) => {
      const { runFfprobe } = require('../../plugin/core/ffmpeg-run');
      const out = await runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_format', f]);
      return parseFloat(JSON.parse(out).format.duration);
    };
    const base = await dur(files.original);
    assert.ok(Math.abs((await dur(trimmed)) - (base - 1.5)) < 0.1, 'a positive shift should drop head');
    assert.ok(Math.abs((await dur(delayed)) - (base + 1.5)) < 0.1, 'a negative shift should pad head');
  } finally {
    for (const f of [trimmed, delayed]) { try { fs.unlinkSync(f); } catch { /* best effort */ } }
  }
});

test('a flat envelope is refused rather than aligned on rounding noise', async () => {
  // Two steady tones of different lengths: the pathological case. Both
  // envelopes are near-constant, so after mean-centring every lag correlates
  // equally and the winner is decided by numerical noise. The pipeline's own
  // mismatch fixture is exactly this, and it used to report a confident match.
  const a = await fx.buildTone(path.join(workDir, 'flat-long.wav'), { duration: 5, frequency: 170 });
  const b = await fx.buildTone(path.join(workDir, 'flat-short.wav'), { duration: 2, frequency: 170 });
  const r = await align.estimateOffset(a, b);
  assert.ok(!r.confident, `a steady tone carries no timing information (contrast ${r.contrast})`);
  assert.equal(r.offsetSec, null);
  assert.ok(r.contrast < align.MIN_ENVELOPE_CONTRAST);
});

test('envelopeContrast separates speech-like shape from a steady level', () => {
  const flat = new Float64Array(500).fill(0.2);
  assert.ok(align.envelopeContrast(flat) < 1e-9, 'a constant level has no shape');

  const speechLike = new Float64Array(500);
  for (let i = 0; i < 500; i++) speechLike[i] = (i % 50) < 30 ? 0.3 : 0.002;
  assert.ok(align.envelopeContrast(speechLike) > align.MIN_ENVELOPE_CONTRAST,
    'words and pauses must clear the bar');

  assert.equal(align.envelopeContrast(new Float64Array(0)), 0);
  assert.equal(align.envelopeContrast(new Float64Array(10)), 0, 'digital silence');
});

test('correlationAt refuses to score an overlap too short to mean anything', () => {
  const a = new Float64Array(50).fill(1);
  const b = new Float64Array(50).fill(1);
  assert.equal(align.correlationAt(a, b, 45), 0,
    'a few points of overlap can correlate perfectly by accident');
});

test('bestLag finds a synthetic shift in envelope space', () => {
  const n = 600;
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i / 7) + Math.sin(i / 23);
  const lag = 37;
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = i - lag >= 0 ? a[i - lag] : 0;

  const r = align.bestLag(a, b, 100);
  assert.equal(r.lag, lag);
  assert.ok(r.correlation > 0.9);
});
