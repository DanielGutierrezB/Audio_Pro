'use strict';

// ── Running the AudioPro chain from the panel ───────────────────────────
// A thin wrapper over core/pipeline.processQueue: one sequence per call, its
// events turned into row updates, and a JSON sidecar written next to the
// master.
//
// The sidecar is the point of this file as much as the render is. The chain
// measures a lot about a recording and then throws almost all of it away once
// the file is written: which flags fired, what the input loudness was, the
// tilt, whether the Mode 2 pair was actually used, and — the one that has
// burned this project before — *which ffmpeg ran*. When a class comes back
// sounding wrong, that file is the difference between knowing and guessing.
//
// It also records `mode`, which the caller needs for a decision, not just for
// the log: mode 1 means the pair was rejected and the master has no Adobe pass
// in it, so it is not what the editor asked for and must not quietly replace
// the clip on the timeline.

const fs = require('fs');

const pipeline = require('../core/pipeline');
const binPaths = require('../core/bin-paths');
const CORE_VERSION = require('../core/CORE_VERSION');

// Masters one file. `onProgress(step, pct)` drives the row; `onNote(text)`
// goes to the log.
//
// Resolves to { ok, outputPath, mode, verify, flags, sidecarPath } or
// { ok: false, error }. It does not throw for a per-file failure: the row has
// to be able to say what went wrong and offer a retry, and the Adobe audio is
// already on the timeline either way.
async function masterOne({
  originalPath,
  enhancedPath,
  settings,
  sequenceName,
  onProgress = () => {},
  onNote = () => {},
  setCurrent = () => {},
}) {
  const file = { path: originalPath, pairPath: enhancedPath };

  let outputPath = null;
  let mode = null;
  let verify = null;
  let flags = [];
  let loudnessIn = null;
  let tilt = null;
  let skipped = null;
  let error = null;
  const notes = [];

  const emit = (type, data) => {
    switch (type) {
      case 'file:start':
        onProgress('masterizando', 0);
        break;
      case 'progress':
        onProgress(data.step, data.pct);
        break;
      case 'qc':
        flags = (data.flags || []).map(f => ({ code: f.code, detail: f.detail }));
        loudnessIn = data.loudnessIn ?? null;
        tilt = data.tilt ?? null;
        mode = data.mode ?? mode;
        if (flags.length) onNote('QC: ' + flags.map(f => f.code).join(', '));
        break;
      case 'loudness':
        notes.push(data.message);
        onNote(data.message);
        break;
      case 'file:done':
        outputPath = data.outputPath;
        mode = data.mode;
        verify = data.verify;
        break;
      case 'file:skipped':
        // Should not happen: skipUnchanged is false for this path. If it ever
        // does, treat it as a failure rather than reporting success for a
        // render that never ran — the clip would stay in Mango forever while
        // the row claimed it was done.
        skipped = data.reason;
        break;
      case 'file:error':
        error = data.error;
        break;
      case 'batch:done':
        break;
      default:
        break;
    }
  };

  await pipeline.processQueue([file], { emit, isCancelled: () => false, setCurrent, settings });

  if (error) return { ok: false, error };
  if (skipped) return { ok: false, error: `el pipeline saltó el archivo (${skipped})` };
  if (!outputPath) {
    return { ok: false, error: 'el pipeline no devolvió un master' };
  }

  const sidecarPath = writeSidecar(outputPath, {
    sequence: sequenceName,
    originalPath,
    enhancedPath,
    mode,
    verify,
    flags,
    loudnessIn,
    tilt,
    notes,
    settings,
  });

  if (!sidecarPath) onNote('⚠ no pude escribir el JSON del master (QC, loudness, motor)');
  return { ok: true, outputPath, mode, verify, flags, tilt, sidecarPath };
}

// Written next to the master, same stem, .json. Best-effort: a sidecar that
// cannot be written is not worth failing a finished master over. Returns null
// in that case, and masterOne logs it, because its absence is itself a symptom.
function writeSidecar(outputPath, data) {
  const sidecarPath = outputPath.replace(/\.[^.]+$/, '') + '.json';
  const binDir = binPaths.getBinDir();
  const payload = {
    sequence: data.sequence,
    renderedAt: new Date().toISOString(),
    mode: data.mode,
    // Spelled out because "mode: 1" in a file read six months from now says
    // nothing, and the distinction is the whole value of the Adobe pass.
    modeMeaning: data.mode === 2
      ? 'original + Adobe Podcast 100% (fusión por bandas)'
      : 'solo el original — el par con Adobe fue rechazado',
    verify: data.verify,
    qc: {
      flags: data.flags,
      loudnessIn: data.loudnessIn,
      tilt: data.tilt,
    },
    notes: data.notes,
    inputs: {
      original: data.originalPath,
      enhanced: data.enhancedPath,
    },
    settings: data.settings,
    engine: {
      core: CORE_VERSION,
      ffmpegDir: binDir,
      ffmpeg: binDir ? binPaths.versionLine(binDir) : null,
    },
  };
  try {
    fs.writeFileSync(sidecarPath, JSON.stringify(payload, null, 2));
    return sidecarPath;
  } catch {
    return null;
  }
}

// The one-line log entry for a finished master.
function describeResult(result) {
  if (!result.ok) return result.error;
  const v = result.verify || {};
  const badge = v.badge === 'ok' ? '✓' : '⚠';
  const loudness = v.i != null ? `${v.i} LUFS / ${v.tp} dBTP` : 'sin medición';
  return `${badge} master (modo ${result.mode}) ${loudness}`;
}

module.exports = { masterOne, writeSidecar, describeResult };
