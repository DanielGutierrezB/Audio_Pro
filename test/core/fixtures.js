'use strict';

// ── Synthetic audio fixtures for the QC/metrics regression suite ──
// Builds small speech-like WAV files entirely with FFmpeg lavfi sources
// (sine partials + pink/white noise, no real recordings needed) so the
// test suite has no external assets to check in. Each "voice" segment
// mixes a fundamental, broadband texture, a presence partial and a touch
// of air, scaled to a target peak; "silence" segments simulate the
// natural pauses between sentences that make Noise_floor measurements
// meaningful. See docs/PLAN.md §1.4 for the artifact catalogue and §6
// for the FFmpeg commands these fixtures exercise.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runFfmpeg } = require('../../plugin/core/ffmpeg-run');

const SR = 48000;
const BUILD_TIMEOUT_MS = 60 * 1000;

// anoisesrc defaults to a time-seeded RNG (seed=-1), which made the "clean"
// fixture's measured DC offset drift randomly between runs — occasionally
// past the 0.003 detection threshold and flaking the "zero false positives"
// test in CI. Every anoisesrc call below is pinned to this fixed seed so the
// whole synthetic corpus renders byte-for-byte the same on every run.
const NOISE_SEED = 20260715;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `audiopro-${prefix}-`));
}

function voiceSegmentGraph(duration, peakDb, { fundamental = 180, presence = 2400, air = 9000 } = {}) {
  const lin = Math.pow(10, peakDb / 20);
  return `sine=frequency=${fundamental}:sample_rate=${SR}:duration=${duration},volume=${(lin * 1.1).toFixed(5)}[a];` +
    `anoisesrc=color=pink:sample_rate=${SR}:duration=${duration}:amplitude=${(lin * 0.9).toFixed(5)}:seed=${NOISE_SEED}[b];` +
    `sine=frequency=${presence}:sample_rate=${SR}:duration=${duration},volume=${(lin * 0.22).toFixed(5)}[c];` +
    `sine=frequency=${air}:sample_rate=${SR}:duration=${duration},volume=${(lin * 0.05).toFixed(5)}[d];` +
    `[a][b][c][d]amix=inputs=4:normalize=0[out]`;
}

function silenceSegmentGraph(duration, floorDb = -75) {
  const lin = Math.pow(10, floorDb / 20);
  return `anoisesrc=color=white:sample_rate=${SR}:duration=${duration}:amplitude=${lin.toFixed(7)}:seed=${NOISE_SEED}[out]`;
}

async function concatSegments(segmentGraphs, outPath) {
  const inputs = [];
  const labels = [];
  segmentGraphs.forEach((seg, i) => { inputs.push('-f', 'lavfi', '-i', seg); labels.push(`[${i}:a]`); });
  const graph = `${labels.join('')}concat=n=${segmentGraphs.length}:v=0:a=1[out]`;
  await runFfmpeg([...inputs, '-filter_complex', graph, '-map', '[out]', '-ac', '1', '-ar', String(SR), '-y', outPath],
    { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

// Three "sentences" at different levels/pitches with real pauses between
// them — close enough to a real short recording to exercise loudness,
// rolloff and noise-floor measurements without any false-positive flags.
function cleanSegments(silenceFloorDb = -75) {
  return [
    voiceSegmentGraph(1.4, -16),
    silenceSegmentGraph(0.4, silenceFloorDb),
    voiceSegmentGraph(1.2, -24, { fundamental: 210 }),
    silenceSegmentGraph(0.4, silenceFloorDb),
    voiceSegmentGraph(1.6, -12, { fundamental: 160 }),
  ];
}

async function buildClean(outPath) {
  return concatSegments(cleanSegments(), outPath);
}

// Same cadence as `buildClean`, but the pauses carry an elevated noise
// floor instead of near-digital-silence — simulates a noisy room/mic.
async function buildNoisy(outPath) {
  return concatSegments(cleanSegments(-35), outPath);
}

async function buildHum(outPath, workDir) {
  const base = path.join(workDir, '_humbase.wav');
  await buildClean(base);
  await runFfmpeg([
    '-y', '-i', base,
    '-f', 'lavfi', '-i', `sine=frequency=60:sample_rate=${SR}:duration=5.1,volume=0.18`,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0[out]',
    '-map', '[out]', '-ac', '1', '-ar', String(SR), outPath,
  ], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

async function buildSibilant(outPath, workDir) {
  const base = path.join(workDir, '_sibbase.wav');
  await buildClean(base);
  await runFfmpeg([
    '-y', '-i', base,
    '-f', 'lavfi', '-i', `anoisesrc=color=white:sample_rate=${SR}:duration=5.1:amplitude=0.09:seed=${NOISE_SEED}`,
    '-filter_complex', '[1:a]bandpass=f=7000:width_type=h:w=4000[hf];[0:a][hf]amix=inputs=2:normalize=0[out]',
    '-map', '[out]', '-ac', '1', '-ar', String(SR), outPath,
  ], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

// Real esses are short bursts, not the constant 5-9 kHz bed `buildSibilant`
// lays down. The flat bed is what the SIBILANT *detector* is calibrated
// against (it measures average band energy), but a dynamic de-esser keys on
// the transient: given a steady bed its adaptive reference simply rides up
// with the bed and it correctly does nothing, which says nothing about
// whether the stage works. This fixture spaces short HF bursts through the
// same voice so the render-side tests have real peaks to act on.
//
// The burst shape is tuned to land in the range real course audio occupies
// (sibilance ~1 dB above presence) and to reproduce what the de-esser does
// to a real class: roughly -6 dB of sibilance for -1.7 dB of presence,
// against -5.5 / -0.7 measured on an actual recording.
const ESS_BURSTS = 6;
const ESS_BURST_SEC = 0.08;
const ESS_GAP_SEC = 0.90;
const ESS_BURST_AMPLITUDE = 0.25;

async function buildSibilantPeaks(outPath, workDir) {
  const base = path.join(workDir, '_sibpeakbase.wav');
  await buildClean(base);

  const bursts = path.join(workDir, '_sibpeakbursts.wav');
  const segments = [];
  for (let i = 0; i < ESS_BURSTS; i++) {
    segments.push(`anoisesrc=color=white:sample_rate=${SR}:duration=${ESS_BURST_SEC}:amplitude=${ESS_BURST_AMPLITUDE}:seed=${NOISE_SEED}`);
    segments.push(silenceSegmentGraph(ESS_GAP_SEC, -94));
  }
  await concatSegments(segments, bursts);

  await runFfmpeg([
    '-y', '-i', base, '-i', bursts,
    '-filter_complex',
    '[1:a]bandpass=f=7500:width_type=h:w=2000[ess];' +
    '[0:a][ess]amix=inputs=2:normalize=0:duration=first[out]',
    '-map', '[out]', '-ac', '1', '-ar', String(SR), outPath,
  ], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

async function buildClipped(outPath, workDir) {
  const base = path.join(workDir, '_clipbase.wav');
  await buildClean(base);
  await runFfmpeg(['-y', '-i', base, '-af', 'volume=8', '-ac', '1', '-ar', String(SR), outPath], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

async function buildNoAir(outPath, workDir) {
  const base = path.join(workDir, '_noairbase.wav');
  await buildClean(base);
  await runFfmpeg(['-y', '-i', base, '-af', 'lowpass=f=5500:poles=2', '-ac', '1', '-ar', String(SR), outPath], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

// One continuous tone+noise bed with no level variation and no pauses —
// already squashed dynamics, the case where the leveler should stand down.
async function buildSquashed(outPath) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', voiceSegmentGraph(5, -18), '-map', '0:a', '-ac', '1', '-ar', String(SR), outPath],
    { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

async function buildSilenceEdges(outPath, workDir) {
  const base = path.join(workDir, '_edgebase.wav');
  await buildClean(base);
  await runFfmpeg([
    '-f', 'lavfi', '-i', silenceSegmentGraph(2.0, -80),
    '-i', base,
    '-f', 'lavfi', '-i', silenceSegmentGraph(1.6, -80),
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', '-ac', '1', '-ar', String(SR), '-y', outPath,
  ], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

async function buildDcOffset(outPath, workDir) {
  const base = path.join(workDir, '_dcbase.wav');
  await buildClean(base);
  await runFfmpeg(['-y', '-i', base, '-af', 'dcshift=shift=0.02', '-ac', '1', '-ar', String(SR), outPath], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

// A ~3 s plain tone, reused as a stand-in "enhanced" track for pairing/
// fusion tests where the exact spectral content doesn't matter, only
// that two distinct, same-duration files exist.
async function buildTone(outPath, { duration = 3, frequency = 440, peakDb = -18 } = {}) {
  const lin = Math.pow(10, peakDb / 20);
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${SR}:duration=${duration},volume=${lin.toFixed(5)}`,
    '-ac', '1', '-ar', String(SR), outPath,
  ], { timeout: BUILD_TIMEOUT_MS });
  return outPath;
}

function rand() { return crypto.randomBytes(3).toString('hex'); }

module.exports = {
  SR,
  tmpDir,
  buildClean, buildNoisy, buildHum, buildSibilant, buildSibilantPeaks, buildClipped,
  buildNoAir, buildSquashed, buildSilenceEdges, buildDcOffset, buildTone,
  rand,
};
