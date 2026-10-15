'use strict';

// ── Mode 2 pair alignment ───────────────────────────────────────────────
// Mode 2 fuses an original take with its Adobe Podcast counterpart, which
// only works if the two line up sample-for-sample. Until now the pipeline
// just compared durations and, on a mismatch, silently fell back to Mode 1 on
// the original — the user got a plain master with no indication that the
// Adobe pass they paid credits for had been dropped.
//
// Adobe trims leading and trailing silence on its own, so a mismatch usually
// means a constant offset, not a different recording. That is recoverable:
// find the offset and trim it out.
//
// The offset is found by cross-correlating the two amplitude envelopes rather
// than the waveforms. Enhance Speech rewrites the waveform — that is its whole
// job, so sample-level correlation is weak — but it preserves *when* speech
// happens, which is what the envelope captures. It is also what makes this
// affordable: at 100 points per second a four-minute take is 24k points
// instead of 11M samples.

const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { runFfmpeg, runFfmpegCapture } = require('./ffmpeg-run');

const DECODE_SR = 8000;          // plenty for an amplitude envelope
const ENVELOPE_HZ = 100;         // one RMS point per 10 ms
const SAMPLES_PER_POINT = DECODE_SR / ENVELOPE_HZ;
// Only the opening stretch is needed to find a constant offset, and bounding
// it keeps the cost flat on a 40-minute recording.
const ANALYZE_SECONDS = 180;
const MAX_OFFSET_SEC = 15;
// Pearson correlation below this means the two files are not the same take
// (wrong pairing, a re-recorded class) rather than a shifted one. Envelope
// correlation between an original and its enhanced version runs high — well
// above 0.8 on the real corpus — so this is a wide margin, deliberately: the
// cost of a wrong alignment is a mangled master, the cost of refusing is the
// Mode 1 fallback that already existed.
const MIN_CORRELATION = 0.6;
// A correlation is only meaningful if the envelope it came from has shape.
// Speech is mostly shape — words and the pauses between them put this well
// above 0.5 — while a steady tone or a continuous bed sits near zero, and at
// that point every lag "matches" equally: mean-centring leaves near-zero
// variance on both sides, so the winning lag is decided by rounding noise.
// Without this guard a flat pair reports a confident alignment and fusion
// happily mangles it.
const MIN_ENVELOPE_CONTRAST = 0.25;
const DECODE_TIMEOUT_MS = 3 * 60 * 1000;

// RMS amplitude envelope of the first ANALYZE_SECONDS, as Float64Array.
async function envelope(filePath) {
  const pcm = await runFfmpegCapture([
    '-v', 'error',
    '-t', String(ANALYZE_SECONDS),
    '-i', filePath,
    '-af', `aformat=channel_layouts=mono,aresample=${DECODE_SR}`,
    '-f', 's16le', '-',
  ], { timeout: DECODE_TIMEOUT_MS });

  const points = Math.floor(pcm.length / 2 / SAMPLES_PER_POINT);
  const env = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    let sum = 0;
    const base = i * SAMPLES_PER_POINT * 2;
    for (let j = 0; j < SAMPLES_PER_POINT; j++) {
      const s = pcm.readInt16LE(base + j * 2) / 32768;
      sum += s * s;
    }
    env[i] = Math.sqrt(sum / SAMPLES_PER_POINT);
  }
  return env;
}

function mean(arr, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += arr[i];
  return sum / (to - from);
}

// Coefficient of variation of the envelope: how much of it is shape rather
// than a constant level. Zero for digital silence or a steady tone.
function envelopeContrast(env) {
  if (!env.length) return 0;
  const m = mean(env, 0, env.length);
  if (m <= 0) return 0;
  let variance = 0;
  for (let i = 0; i < env.length; i++) variance += (env[i] - m) ** 2;
  return Math.sqrt(variance / env.length) / m;
}

// Pearson correlation of `a` against `b` shifted by `lag` points, over the
// overlapping region only. Mean-centred per lag so a loud file and a quiet one
// still correlate on shape rather than level.
function correlationAt(a, b, lag) {
  const start = Math.max(0, -lag);
  const end = Math.min(a.length, b.length - lag);
  const n = end - start;
  if (n < ENVELOPE_HZ) return 0; // less than a second of overlap says nothing

  const ma = mean(a, start, end);
  let mb = 0;
  for (let i = start; i < end; i++) mb += b[i + lag];
  mb /= n;

  let num = 0, da = 0, db = 0;
  for (let i = start; i < end; i++) {
    const x = a[i] - ma;
    const y = b[i + lag] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

// Searches lags coarsely, then refines around the winner — a full scan at
// 10 ms resolution over +/-15 s is 3000 lags x 18k points, which is enough
// work to notice on a batch.
function bestLag(a, b, maxLagPoints) {
  const coarseStep = 10; // 100 ms
  let bestCoarse = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLagPoints; lag <= maxLagPoints; lag += coarseStep) {
    const score = correlationAt(a, b, lag);
    if (score > bestScore) { bestScore = score; bestCoarse = lag; }
  }
  let best = bestCoarse;
  for (let lag = bestCoarse - coarseStep; lag <= bestCoarse + coarseStep; lag++) {
    if (Math.abs(lag) > maxLagPoints) continue;
    const score = correlationAt(a, b, lag);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  return { lag: best, correlation: bestScore };
}

// Estimates how far `enhancedPath` sits from `originalPath`.
// A positive offsetSec means the enhanced file starts LATER in the take, i.e.
// its opening was trimmed, so the original needs that much taken off its head
// to line up.
async function estimateOffset(originalPath, enhancedPath) {
  const [a, b] = await Promise.all([envelope(originalPath), envelope(enhancedPath)]);
  if (!a.length || !b.length) {
    return { offsetSec: null, correlation: 0, contrast: 0, confident: false };
  }
  const contrast = Math.min(envelopeContrast(a), envelopeContrast(b));
  if (contrast < MIN_ENVELOPE_CONTRAST) {
    return { offsetSec: null, correlation: 0, contrast, confident: false };
  }
  const { lag, correlation } = bestLag(a, b, MAX_OFFSET_SEC * ENVELOPE_HZ);
  return {
    offsetSec: -lag / ENVELOPE_HZ,
    correlation,
    contrast,
    confident: correlation >= MIN_CORRELATION,
  };
}

function tempPath(reference) {
  const stem = path.basename(reference, path.extname(reference));
  return path.join(os.tmpdir(), `audiopro-aligned-${crypto.randomBytes(4).toString('hex')}-${stem}.wav`);
}

// Writes a copy of `filePath` with `trimSec` removed from its head (or
// `trimSec` of silence prepended when negative). Returns the new path.
async function renderShifted(filePath, trimSec, opts = {}) {
  const outPath = tempPath(filePath);
  const filter = trimSec >= 0
    ? `atrim=start=${trimSec.toFixed(3)},asetpts=PTS-STARTPTS`
    : `adelay=delays=${Math.round(-trimSec * 1000)}:all=1`;
  await runFfmpeg(['-y', '-i', filePath, '-af', filter, '-c:a', 'pcm_s24le', outPath], opts);
  return outPath;
}

module.exports = {
  estimateOffset,
  renderShifted,
  MAX_OFFSET_SEC,
  MIN_CORRELATION,
  MIN_ENVELOPE_CONTRAST,
  ENVELOPE_HZ,
  // exported for tests
  correlationAt,
  bestLag,
  envelopeContrast,
};
