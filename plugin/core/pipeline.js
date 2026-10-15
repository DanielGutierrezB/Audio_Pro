'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { runFfmpeg, runFfprobe } = require('./ffmpeg-run');
const binPaths = require('./bin-paths');
const metrics = require('./metrics');
const fusion = require('./fusion');
const align = require('./align');
const renderManifest = require('./render-manifest');
const { getPreset } = require('./presets');

// ── Base EQ (F6-style) ──
// Cuts happen before dynamics (they shape what the compressor reacts to);
// boosts happen after (so we're not boosting presence/air only to have
// the leveler immediately squash it back down). Manual overrides from the
// EQ editor replace both halves at once, applied at the cuts position —
// that mirrors what the editor's live preview plays back (source + one
// combined curve, no separate dynamics stage), so "Process All" matches
// what the user just auditioned.
const EQ_CUTS = [
  { f: 150, q: 2,   g: -3 },  // mud
  { f: 280, q: 2.5, g: -3 },  // box
  { f: 500, q: 2,   g: -4 },  // honk
];
const EQ_PRESENCE = { f: 3589, q: 1.0, g: 1 };
const EQ_AIR_SHELF = { f: 10000, g: 1.5 };
const DEFAULT_HPF_HZ = 80;

// ── Adaptive tilt correction ──
// The cuts above are a fixed curve, so however dark a source arrives, it
// leaves exactly that much darker. That is the remaining half of "Adobe gives
// too much bass, it varies by voice": Adobe adds ~2.5 dB of relative low end,
// but not the same amount every time, and different voices start from
// different places. A shelf scaled to the measured tilt (src/metrics.js
// tiltOf) pulls every source toward one balance instead.
//
// REFERENCE is the source tilt the fixed curve is calibrated against: the four
// real classes measure 12.9-14.7 dB at this point in the chain (after Mode 2
// fusion) and the curve takes them to a 10.2-11.7 dB master. A file arriving
// at the reference therefore gets no extra shelf and renders exactly as the
// validated chain did; everything else is pulled toward it.
//
// PER_DB is measured, not assumed: a low shelf at 300 Hz moves tilt by
// 0.65 dB for every 1 dB of gain, linearly and consistently across all three
// classes tested (15.1 -> 11.2 dB over a 6 dB shelf).
const TONE_TILT_REFERENCE_DB = 14;
const TONE_TILT_SHELF_HZ = 300;
const TONE_TILT_DB_PER_SHELF_DB = 0.65;
// Caps the shelf at a correction of roughly 4 dB of tilt in either direction.
// Past that the source is not "a bit dark", it is a different problem (wrong
// mic, proximity effect, a lowpassed take) that an EQ shelf should not paper
// over.
const TONE_TILT_MAX_SHELF_DB = 6;

const DENOISE_WORKING_SR = 48000; // the bundled RNNoise model expects 48 kHz
const HUM_NOTCH_WIDTH_Q = 24;
const HUM_HARMONIC_MULT = 2;
const SILENCE_TRIM_PAD_SEC = 0.3;
const PAIR_DURATION_TOLERANCE_SEC = 0.5;

function hasFlag(qc, code) { return qc != null && qc.flags.some(f => f.code === code); }
function getFlag(qc, code) { return qc == null ? undefined : qc.flags.find(f => f.code === code); }

// Shelf gain that brings a source measured at `tilt` back to the reference,
// or null when there is nothing to correct (no measurement, feature off, or
// already within a rounding error of the target).
function tiltShelfGainDb(qc, settings) {
  if (settings.adaptiveToneEnabled === false) return null;
  const tilt = qc?.tilt;
  if (tilt == null) return null;
  const target = settings.toneTiltTarget ?? TONE_TILT_REFERENCE_DB;
  const excessDb = tilt - target;
  const raw = -excessDb / TONE_TILT_DB_PER_SHELF_DB;
  const gain = Math.max(-TONE_TILT_MAX_SHELF_DB, Math.min(TONE_TILT_MAX_SHELF_DB, raw));
  return Math.abs(gain) < 0.2 ? null : gain;
}

function buildEqCutsChain(qc, settings) {
  const hpfF = settings.hpfFrequency ?? DEFAULT_HPF_HZ;
  const parts = [`highpass=f=${hpfF}:poles=2`];
  for (const b of EQ_CUTS) parts.push(`equalizer=f=${b.f}:width_type=q:width=${b.q}:g=${b.g}`);
  const tiltGain = tiltShelfGainDb(qc, settings);
  if (tiltGain != null) parts.push(`lowshelf=f=${TONE_TILT_SHELF_HZ}:g=${tiltGain.toFixed(2)}`);
  return parts.join(',');
}

function buildEqBoostsChain(qc) {
  const parts = [`equalizer=f=${EQ_PRESENCE.f}:width_type=q:width=${EQ_PRESENCE.q}:g=${EQ_PRESENCE.g}`];
  if (!hasFlag(qc, 'NO_AIR')) parts.push(`highshelf=f=${EQ_AIR_SHELF.f}:g=${EQ_AIR_SHELF.g}`);
  return parts.join(',');
}

function buildToneChain(qc, settings) {
  if (settings.manualEqApply === true && typeof settings.manualEqChain === 'string' && settings.manualEqChain.trim()) {
    return { cuts: settings.manualEqChain.trim(), boosts: null };
  }
  return { cuts: buildEqCutsChain(qc, settings), boosts: buildEqBoostsChain(qc) };
}

// ── Conditional repair ──
// adeclick runs unconditionally (cheap, safe defaults, catches mouth
// clicks/plosive pops the analysis pass doesn't explicitly flag).
function buildRepairChain(qc) {
  const parts = ['adeclick'];
  if (hasFlag(qc, 'CLIP')) parts.push('adeclip');
  for (const fl of (qc?.flags ?? [])) {
    if (fl.code === 'HUM') {
      parts.push(`bandreject=f=${fl.hz}:width_type=q:w=${HUM_NOTCH_WIDTH_Q}`);
      parts.push(`bandreject=f=${fl.hz * HUM_HARMONIC_MULT}:width_type=q:w=${HUM_NOTCH_WIDTH_Q}`);
    }
  }
  return parts.join(',');
}

function buildTrimSpec(qc, duration, settings) {
  if (settings.trimSilence === false || qc == null) return null;
  const head = getFlag(qc, 'SILENCE_HEAD');
  const tail = getFlag(qc, 'SILENCE_TAIL');
  if (!head && !tail) return null;
  const start = head ? Math.max(0, head.end - SILENCE_TRIM_PAD_SEC) : 0;
  const end = tail != null
    ? (duration != null ? Math.min(duration, tail.start + SILENCE_TRIM_PAD_SEC) : tail.start + SILENCE_TRIM_PAD_SEC)
    : null;
  if (start <= 0.001 && end == null) return null;
  const endArg = end != null ? `:end=${end.toFixed(3)}` : '';
  return `atrim=start=${start.toFixed(3)}${endArg},asetpts=PTS-STARTPTS`;
}

// Local conditional denoise (Mode 1 only — Mode 2 relies on Adobe's own
// enhancement for the noise floor). Returns null when there's nothing to
// do, or { filter, cwd } — cwd must be the model's own directory because
// embedding an absolute path with a drive-letter colon (Windows) or
// spaces directly in an FFmpeg filter option is unreliable across
// escaping layers; spawning with cwd + a bare filename sidesteps that
// entirely (see docs/PLAN.md §6 for the empirical trail).
function buildDenoiseSpec(qc, settings, mode) {
  if (mode !== 1 || settings.denoiseMode === 'off') return null;
  if (!hasFlag(qc, 'NOISY')) return null;
  const modelPath = binPaths.rnnoiseModel();
  if (!modelPath) return null;
  const mix = metrics.denoiseMixFor(qc.noiseFloor);
  if (mix <= 0) return null;
  return {
    filter: `arnndn=m=${path.basename(modelPath)}:mix=${mix.toFixed(2)}`,
    cwd: path.dirname(modelPath),
  };
}

// Gentle, voice-appropriate leveling — not a limiter. Evens out
// sentence-to-sentence loudness swings before the final loudnorm pass.
//
// 2:1 rather than the 3:1 this used to run. Course audio arrives already
// dense (the real corpus measures LRA 3.2-5.5 LU raw and 3.2-4.4 after Adobe
// Podcast, which compresses on its own), and 3:1 on top of that took masters
// down to 2.1-2.8 LU — flat enough that the output tripped the pipeline's own
// FLAT_DYNAMICS detector. There is no range left to protect at that point,
// only range left to lose.
//
// The skip threshold is LRA_LEVELER_SKIP rather than QC_THRESHOLDS.lraFlat:
// FLAT_DYNAMICS answers "is this already squashed" for reporting, while this
// answers "would compressing make it worse", and the second kicks in earlier.
const LEVELER_SKIP_LRA = 4;

function buildLevelerChain(qc, settings) {
  if (settings.compressionMode === 'off') return null;
  if (hasFlag(qc, 'FLAT_DYNAMICS')) return null;
  const lra = qc?.loudness?.lra;
  if (lra != null && lra < LEVELER_SKIP_LRA) return null;
  return 'acompressor=threshold=-24dB:ratio=2:attack=15:release=250:makeup=2:knee=6';
}

function clampPct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }

// ── De-esser ──
// Both stages below are intensity-driven (0–100%); the old on/off flags are
// honoured as a fallback (≈60%) so settings files that predate the sliders
// keep working.
//
// Two things about `adynamicequalizer` broke every version up to v0.7.0:
// its `mode=0` is `cutbelow`, which attenuates while the detection band is
// *below* the threshold (the inverse of a de-esser), and `threshold` is
// linear amplitude, not dB — so `threshold=15` sat above full scale and the
// stage attenuated every sample. Measured on a real class: a near-constant
// −17.5 dB out of 5–9 kHz plus −6 dB of collateral presence loss, i.e. the
// "muddy, no clarity" complaint was coming from the de-esser itself.
//
// `auto=adaptive` rather than any fixed threshold, because this stage runs
// *before* loudnorm and therefore sees raw source level. Same class at
// −12 / 0 / +12 dB input gain: a fixed threshold reduced sibilance by
// −0.3 / −2.6 / −4.2 dB, adaptive held −5.5 dB throughout.
//
// Detection and target sit at 7.5 kHz with a narrow target bell. At 6.5 kHz
// with tqfactor=1.5 the bell's skirt reached into the 2–5 kHz presence band
// and cost 2.6 dB there to get 9.4 dB of sibilance; 7.5 kHz at tqfactor=3.5
// gets 5.7 dB of sibilance for 1.2 dB of presence.
// `mode` and `auto` go in numerically because the named spellings
// (`cutabove`, `adaptive`) are rejected by the ffmpeg 6.1 that CI installs
// from apt, while the numeric values are stable across versions. An opaque
// number in the filter string is exactly what hid the original bug, so the
// meaning lives in these names instead.
const DEQ_MODE_CUTABOVE = 1;  // 0 is cutbelow: attenuates everything *but* the esses
const DEQ_AUTO_ADAPTIVE = 4;  // threshold tracks the signal instead of a fixed level
const DEESSER_FREQ_HZ = 7500;
const DEESSER_RANGE_MIN_DB = 2;
const DEESSER_RANGE_SPAN_DB = 10;
// What the SIBILANT flag alone asks for when the user left the slider at 0.
const DEESSER_AUTO_PCT = 50;

function buildDeesserChain(qc, settings) {
  let amt = settings.deEsserAmount != null ? clampPct(settings.deEsserAmount) : (settings.deEsserEnabled ? 60 : 0);
  // Still auto-engage on measured sibilance even if the user left it at 0.
  if (amt <= 0 && hasFlag(qc, 'SIBILANT')) amt = DEESSER_AUTO_PCT;
  if (amt <= 0) return null;
  const range = (DEESSER_RANGE_MIN_DB + (amt / 100) * DEESSER_RANGE_SPAN_DB).toFixed(1);
  return `adynamicequalizer=dfrequency=${DEESSER_FREQ_HZ}:dqfactor=2:` +
    `tfrequency=${DEESSER_FREQ_HZ}:tqfactor=3.5:` +
    `ratio=6:range=${range}:mode=${DEQ_MODE_CUTABOVE}:auto=${DEQ_AUTO_ADAPTIVE}`;
}

function buildExciterChain(settings) {
  const amt = settings.airExtraAmount != null ? clampPct(settings.airExtraAmount) : (settings.airExtraEnabled ? 60 : 0);
  if (amt <= 0) return null;
  const f = amt / 100;
  const amount = (f * 2).toFixed(2);  // 0 → 2
  const blend  = (f * 0.5).toFixed(2); // 0 → 0.5
  return `aexciter=amount=${amount}:drive=6:blend=${blend}:freq=7500:ceil=15000`;
}

function buildOutputCodecArgs(settings) {
  const format = settings.outputFormat ?? 'wav24';
  const sr = String(settings.sampleRate ?? 48000);
  switch (format) {
    case 'wav16': return ['-acodec', 'pcm_s16le', '-ar', sr];
    case 'flac':  return ['-acodec', 'flac', '-ar', sr];
    default:      return ['-acodec', 'pcm_s24le', '-ar', sr];
  }
}

function resolveOutputPath(inputPath, settings) {
  const format = settings.outputFormat ?? 'wav24';
  const ext = format === 'flac' ? '.flac' : '.wav';
  const baseName = path.basename(inputPath, path.extname(inputPath)) + ext;
  const customDir = settings.customOutputDir;
  if (typeof customDir === 'string' && customDir) {
    fs.mkdirSync(customDir, { recursive: true });
    return path.join(customDir, baseName);
  }
  const inputDir = path.dirname(inputPath);
  const outputDir = path.join(path.dirname(inputDir), 'Audio_Pro');
  fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, baseName);
}

function tempPathFor(inputPath, suffix) {
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `audiopro-${suffix}-${rand}-${path.basename(inputPath, path.extname(inputPath))}.wav`);
}

// ── ffprobe basic metadata ──
async function probeBasic(filePath) {
  const out = await runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath]);
  const probe = JSON.parse(out);
  const audio = probe.streams?.find(s => s.codec_type === 'audio');
  return {
    duration:   parseFloat(probe.format?.duration) || null,
    sampleRate: parseInt(audio?.sample_rate) || null,
    channels:   parseInt(audio?.channels) || 1,
  };
}

function buildPreEqChain(meta, targetSr) {
  const parts = ['aformat=channel_layouts=mono'];
  if (meta.sampleRate !== targetSr) parts.push(`aresample=${targetSr}:filter_size=64`);
  return parts.join(',');
}

// ── Assemble the render-time filter graph ──
// Plain comma chain when there's no parallel (body) branch — cheapest
// and matches what most files need. A body weight > 0 needs a real
// filter_complex graph: split the tone-shaped signal, compress one leg,
// mix it back under the dry signal (parallel/"New York" compression),
// then continue into the boosts + loudness stage.
function assembleGraph(prefixParts, bodyPct, suffixParts) {
  const prefix = prefixParts.filter(Boolean).join(',');
  const suffix = suffixParts.filter(Boolean).join(',');
  if (!bodyPct || bodyPct <= 0) {
    return { chain: [prefix, suffix].filter(Boolean).join(',') };
  }
  const weight = (bodyPct / 100).toFixed(3);
  const tail = suffix ? `[bodyd]${suffix}[out]` : '[bodyd]acopy[out]';
  const graph =
    `[0:a]${prefix}[dry];` +
    `[dry]asplit=2[dry1][dry2];` +
    `[dry2]acompressor=threshold=-28dB:ratio=6:attack=8:release=280:makeup=8[wet];` +
    `[dry1][wet]amix=inputs=2:weights=1 ${weight}:normalize=0[bodyd];` +
    tail;
  return { graph, mapOut: '[out]' };
}

function runGraph(inputPath, outputArgs, assembled, opts) {
  const args = ['-y', '-i', inputPath];
  if (assembled.graph) args.push('-filter_complex', assembled.graph, '-map', assembled.mapOut);
  else args.push('-af', assembled.chain);
  args.push(...outputArgs);
  return runFfmpeg(args, opts);
}

// ── Measure loudness after the full processing chain (minus loudnorm/limiter) ──
async function measureLoudness(inputPath, prefixParts, bodyPct, suffixParts, preset, duration, onProgress, setCurrent, cwd) {
  const measureSuffix = [...suffixParts, `loudnorm=I=${preset.i}:TP=${preset.tp}:LRA=${preset.lra}:print_format=json`];
  const assembled = assembleGraph(prefixParts, bodyPct, measureSuffix);
  const stderr = await runGraph(inputPath, ['-f', 'null', '-'], assembled, { duration, onProgress, setCurrent, cwd });
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      inputI:       parseFloat(j.input_i),
      inputLra:     parseFloat(j.input_lra),
      inputTp:      parseFloat(j.input_tp),
      inputThresh:  parseFloat(j.input_thresh),
      targetOffset: parseFloat(j.target_offset ?? '0'),
    };
  } catch {
    return null;
  }
}

// ── Render: full chain + (optional) loudnorm + safety limiter ──
async function renderFile(inputPath, outputPath, prefixParts, bodyPct, suffixParts, stats, applyLoudnorm, preset, settings, duration, onProgress, setCurrent, cwd) {
  const codecArgs = buildOutputCodecArgs(settings);
  const renderSuffix = [...suffixParts];
  if (applyLoudnorm && stats) {
    renderSuffix.push(
      `loudnorm=I=${preset.i}:TP=${preset.tp}:LRA=${preset.lra}:` +
      `measured_I=${stats.inputI}:measured_LRA=${stats.inputLra}:` +
      `measured_TP=${stats.inputTp}:measured_thresh=${stats.inputThresh}:` +
      `offset=${stats.targetOffset}`
    );
  }
  // Safety net regardless of loudnorm's own TP handling — loudnorm's
  // dynamic mode (used when linear gain would exceed the TP ceiling) can
  // still leave the odd transient a fraction over, and files that skip
  // loudnorm entirely (already at/above target) never got a TP check.
  renderSuffix.push(`alimiter=limit=${dbToLinear(preset.tp)}:attack=3:release=50:level=false`);
  const assembled = assembleGraph(prefixParts, bodyPct, renderSuffix);
  await runGraph(inputPath, [...codecArgs, outputPath], assembled, { duration, onProgress, setCurrent, cwd });
}

function dbToLinear(db) { return Math.min(1, Math.pow(10, db / 20)); }

// ── Quick post-render verification ──
async function verifyOutput(outputPath, preset) {
  try {
    const stderr = await runFfmpeg(['-i', outputPath, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { timeout: 2 * 60 * 1000 });
    const iMatch  = stderr.match(/I:\s+(-?[\d.]+) LUFS/);
    const tpMatch = stderr.match(/Peak:\s+(-?[\d.]+) dBFS/);
    const i  = iMatch ? parseFloat(iMatch[1]) : null;
    const tp = tpMatch ? parseFloat(tpMatch[1]) : null;
    const iOk  = i == null  || Math.abs(i - preset.i) <= 0.7;
    const tpOk = tp == null || tp <= preset.tp + 0.3;
    return { i, tp, badge: iOk && tpOk ? 'ok' : 'warn' };
  } catch {
    return { i: null, tp: null, badge: 'warn' };
  }
}

// ── ETA ──
function calcEta(startMs, done, total) {
  if (done === 0) return null;
  const elapsed = (Date.now() - startMs) / 1000;
  return Math.round(elapsed / done * (total - done));
}

// ── Per-file processing ──
async function processFile(file, settings, { emit, isCancelled, setCurrent, t0, done, total }) {
  const preset = getPreset(settings.platformPreset);
  const tempFiles = [];
  const cleanup = () => { for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } } };

  try {
    let workingPath = file.path;
    let mode = 1;
    let stepTotal = 4;
    let stepIndex = 0;
    // Set when a Mode 2 pair needed realigning or couldn't be used at all;
    // merged into the QC flags below so it reaches the file row and the report
    // rather than only the log.
    let pairNote = null;

    // Checked first: fusion, the analysis pass and the loudness measure all
    // run before anything is written, and all of them cost real time. Re-running
    // a course to fix two classes should not re-render the other thirty-eight.
    const outputPath = resolveOutputPath(file.path, settings);
    const fingerprint = renderManifest.fingerprint(file, settings);
    if (settings.skipUnchanged !== false && renderManifest.isUpToDate(outputPath, fingerprint)) {
      emit('file:skipped', { file: file.path, outputPath, reason: 'unchanged since the last render' });
      return;
    }

    if (file.pairPath && settings.fusionEnabled !== false) {
      stepTotal = 5;
      stepIndex = 1;
      emit('progress', { file: file.path, step: 'Checking alignment', stepIndex, stepTotal, pct: 1, eta: calcEta(t0, done, total) });
      const [origMeta, enhMeta] = await Promise.all([probeBasic(file.path), probeBasic(file.pairPath)]);
      const durOk = origMeta.duration != null && enhMeta.duration != null &&
        Math.abs(origMeta.duration - enhMeta.duration) <= PAIR_DURATION_TOLERANCE_SEC;

      // A duration mismatch used to drop straight to Mode 1 with nothing but a
      // log line, quietly throwing away the Adobe pass the user spent credits
      // on. Adobe trims leading/trailing silence, so the usual cause is a
      // constant offset: measure it and trim it out. Only files that really
      // aren't the same take fall back now, and they say so on the file row.
      let fuseOriginal = file.path;
      let fuseEnhanced = file.pairPath;
      if (!durOk) {
        emit('progress', { file: file.path, step: 'Realigning pair', stepIndex, stepTotal, pct: 2, eta: calcEta(t0, done, total) });
        const shift = await align.estimateOffset(file.path, file.pairPath);
        if (shift.confident && Math.abs(shift.offsetSec) > 0.01) {
          // offsetSec > 0 means the enhanced file starts later in the take, so
          // the original carries that much extra head to drop.
          const [target, trim] = shift.offsetSec > 0
            ? ['original', shift.offsetSec]
            : ['enhanced', -shift.offsetSec];
          const shifted = await align.renderShifted(
            target === 'original' ? file.path : file.pairPath, trim, { setCurrent });
          tempFiles.push(shifted);
          if (target === 'original') fuseOriginal = shifted; else fuseEnhanced = shifted;
          pairNote = {
            code: 'PAIR_REALIGNED',
            detail: `pair was ${Math.abs(shift.offsetSec).toFixed(2)}s out of sync (correlation ${shift.correlation.toFixed(2)}) — realigned`,
          };
          emit('loudness', { file: file.path, message: `Pair realigned by ${shift.offsetSec.toFixed(2)}s (correlation ${shift.correlation.toFixed(2)})` });
        } else {
          pairNote = {
            code: 'PAIR_MISMATCH',
            detail: shift.offsetSec == null
              ? 'could not compare the pair — processed the original only, without the Adobe pass'
              : `the pair doesn't look like the same take (best correlation ${shift.correlation.toFixed(2)}, ` +
                `orig ${origMeta.duration?.toFixed(1)}s vs enhanced ${enhMeta.duration?.toFixed(1)}s) — ` +
                'processed the original only, without the Adobe pass',
          };
          emit('loudness', { file: file.path, message: `Pair mismatch — ${pairNote.detail}` });
        }
      }

      if (durOk || pairNote?.code === 'PAIR_REALIGNED') {
        mode = 2;
        emit('progress', { file: file.path, step: 'Fusing sources', stepIndex, stepTotal, pct: 4, eta: calcEta(t0, done, total) });
        const fusedPath = tempPathFor(file.path, 'fused');
        tempFiles.push(fusedPath);
        await fusion.runFusion(fuseOriginal, fuseEnhanced, fusedPath, settings, {
          duration: origMeta.duration, setCurrent,
          onProgress: frac => emit('progress', { file: file.path, step: 'Fusing sources', stepIndex, stepTotal, pct: Math.round(4 + frac * 8), eta: calcEta(t0, done, total) }),
        });
        workingPath = fusedPath;
      }
    }

    stepIndex++;
    emit('progress', { file: file.path, step: 'Reading metadata', stepIndex, stepTotal, pct: mode === 2 ? 14 : 2, eta: calcEta(t0, done, total) });
    const meta = await probeBasic(workingPath);
    const duration = meta.duration ?? file.duration ?? null;
    if (isCancelled()) return;

    stepIndex++;
    emit('progress', { file: file.path, step: 'Analyzing audio', stepIndex, stepTotal, pct: mode === 2 ? 20 : 8, eta: calcEta(t0, done, total) });
    let qc = null;
    try {
      qc = await metrics.analyzeFile(workingPath);
    } catch (err) {
      emit('loudness', { file: file.path, message: `Analysis failed (${err.message}) — continuing with baseline processing` });
    }
    if (pairNote) {
      if (qc) qc.flags.unshift(pairNote);
      else emit('qc', { file: file.path, mode, flags: [pairNote], loudnessIn: null });
    }
    if (qc) {
      emit('qc', {
        file: file.path, mode,
        flags: qc.flags.map(f => ({ code: f.code, detail: f.detail })),
        loudnessIn: qc.loudness,
        // Carried through to the QC report, where the spread across a course
        // matters more than any single file's value.
        tilt: qc.tilt,
      });
    }
    if (isCancelled()) return;

    const denoiseSpec = buildDenoiseSpec(qc, settings, mode);
    const targetSr = denoiseSpec ? DENOISE_WORKING_SR : parseInt(settings.sampleRate ?? 48000, 10);
    const preChain = buildPreEqChain(meta, targetSr);
    const trimChain = buildTrimSpec(qc, duration, settings);
    const repairChain = buildRepairChain(qc);
    const tone = buildToneChain(qc, settings);
    const levelerChain = buildLevelerChain(qc, settings);
    const deesserChain = buildDeesserChain(qc, settings);
    const exciterChain = buildExciterChain(settings);
    const bodyPct = Math.max(0, Math.min(100, settings.bodyPct ?? 0));

    // tone.boosts is null only when a manual EQ override is active (it
    // already carries its own presence/air shaping) — exciter and the
    // dynamic de-esser are independent stages and still apply on top.
    const prefixParts = [preChain, trimChain, denoiseSpec?.filter, repairChain, tone.cuts, levelerChain];
    const suffixParts = [tone.boosts, exciterChain, deesserChain];
    const cwd = denoiseSpec?.cwd;

    stepIndex++;
    emit('progress', { file: file.path, step: 'Measuring loudness', stepIndex, stepTotal, pct: mode === 2 ? 26 : 14, eta: calcEta(t0, done, total) });
    const stats = await measureLoudness(workingPath, prefixParts, bodyPct, suffixParts, preset, duration,
      frac => { if (!isCancelled()) emit('progress', { file: file.path, step: 'Measuring loudness', stepIndex, stepTotal, pct: Math.round((mode === 2 ? 26 : 14) + frac * 30), eta: calcEta(t0, done + frac * 0.4, total) }); },
      setCurrent, cwd);
    if (isCancelled()) return;

    const raiseOnly = settings.normalizeMode === 'raiseOnly';
    const applyLoudnorm = stats !== null && (!raiseOnly || stats.inputI < preset.i);
    const verb = stats === null
      ? 'measure failed — render with EQ only'
      : applyLoudnorm
        ? `→ loudnorm to ${preset.i} LUFS, TP ≤ ${preset.tp} dBTP (${preset.label})`
        : `already at/above ${preset.i} LUFS — keep as-is`;
    const summary = stats === null
      ? 'loudness measure failed'
      : `I=${stats.inputI.toFixed(1)} LUFS, TP=${stats.inputTp.toFixed(1)} dBFS, LRA=${stats.inputLra.toFixed(1)} LU ${verb}`;
    console.log(`[AudioPro] ${path.basename(file.path)} [Mode ${mode}]: ${summary}`);
    emit('loudness', { file: file.path, message: summary });

    stepIndex++;
    emit('progress', { file: file.path, step: 'Rendering', stepIndex, stepTotal, pct: mode === 2 ? 58 : 46, eta: calcEta(t0, done + 0.5, total) });
    await renderFile(workingPath, outputPath, prefixParts, bodyPct, suffixParts, stats, applyLoudnorm, preset, settings, duration,
      frac => { if (!isCancelled()) emit('progress', { file: file.path, step: 'Rendering', stepIndex, stepTotal, pct: Math.round((mode === 2 ? 58 : 46) + frac * 44), eta: calcEta(t0, done + 0.5 + frac * 0.5, total) }); },
      setCurrent, cwd);

    renderManifest.record(outputPath, fingerprint);

    const verify = await verifyOutput(outputPath, preset);
    emit('file:done', { file: file.path, outputPath, mode, verify });
  } finally {
    cleanup();
  }
}

// ── Queue runner ──
// A course is 15-40 classes and every stage here is a separate ffmpeg process
// that spends most of its time on one core, so running the queue strictly
// one file at a time left the machine idle. Files are fully independent —
// their own temp paths, their own output, their own ffmpeg instances — so a
// small worker pool is safe.
//
// Deliberately small: each file still runs its own stages in sequence, and
// too many concurrent ffmpeg processes just trade wall-clock for contention
// on a laptop that the editor is also using.
function defaultConcurrency() {
  const cpus = os.availableParallelism?.() ?? os.cpus().length ?? 2;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(cpus / 2)));
}

const MAX_CONCURRENCY = 4;

async function processQueue(files, { emit, isCancelled, setCurrent, settings = {} }) {
  const total = files.length;
  let done = 0;
  let next = 0;
  const t0 = Date.now();

  const concurrency = Math.max(1, Math.min(
    MAX_CONCURRENCY,
    settings.concurrency ?? defaultConcurrency(),
    total,
  ));

  async function worker() {
    while (!isCancelled()) {
      const index = next++;
      if (index >= files.length) return;
      const file = files[index];

      try { fs.accessSync(file.path, fs.constants.R_OK); } catch {
        emit('file:error', { file: file.path, error: 'File not readable or not found' });
        done++;
        continue;
      }

      emit('file:start', { file: file.path, index, total });

      try {
        await processFile(file, settings, { emit, isCancelled, setCurrent, t0, done, total });
      } catch (err) {
        emit('file:error', { file: file.path, error: err.message });
      }
      done++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  emit('batch:done', { total, done });
}

module.exports = {
  processQueue,
  defaultConcurrency, MAX_CONCURRENCY,
  buildDeesserChain, buildExciterChain, buildLevelerChain,
  buildEqCutsChain, tiltShelfGainDb,
  TONE_TILT_REFERENCE_DB, TONE_TILT_MAX_SHELF_DB, TONE_TILT_DB_PER_SHELF_DB,
};
