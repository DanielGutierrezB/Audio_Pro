'use strict';

// ── The six stages, one function each ───────────────────────────────────
// Every stage takes its collaborators as arguments instead of requiring them,
// which is what lets test/queue.test.js drive the whole machine with stubs:
// Premiere, Adobe and ffmpeg are all unavailable in a test runner, and the
// thing worth testing is the order, the error handling and what happens to the
// clip's colour — not any of those three.
//
// Each stage returns a plain result object rather than throwing, except for
// genuinely unexpected failures. The caller (queue.js) decides what a failure
// means, because that differs per stage: a failed export means nothing
// happened, while a failed master means the editor already has usable audio on
// the timeline and the clip should stay Mango.

const path = require('path');
const fs = require('fs');

const PATHS = {
  work: 'Audio_Process',
  enhanced: 'Enhanced',
  master: 'Audio_Pro',
};

// Premiere's sequence names can contain anything a user can type, including
// '/' on macOS, and these become filenames.
function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-. áéíóúñÁÉÍÓÚÑ]/g, '_').trim() || 'secuencia';
}

function dirsFor(projectDir) {
  const work = path.join(projectDir, PATHS.work);
  return {
    work,
    enhanced: path.join(work, PATHS.enhanced),
    master: path.join(work, PATHS.master),
    queueFile: path.join(work, 'queue.json'),
  };
}

function pathsFor(dirs, stem) {
  return {
    original: path.join(dirs.work, `${stem}.wav`),
    enhancedRaw: path.join(dirs.enhanced, `${stem}.raw.wav`),
    enhanced: path.join(dirs.enhanced, `${stem}.wav`),
    master: path.join(dirs.master, `${stem}.wav`),
  };
}

// A re-run must never overwrite a file a project item is pointing at: Premiere
// keeps the media open, the clip on the timeline would silently change under
// the editor, and the previous master — which may be the good one — is gone.
// So each run gets its own stem: `clase`, then `clase_2`, `clase_3`.
function nextStem(dirs, name, workArea) {
  const base = safeName(name) + (workArea ? '_inout' : '');
  for (let n = 1; n < 500; n++) {
    const stem = n === 1 ? base : `${base}_${n}`;
    const p = pathsFor(dirs, stem);
    const taken = Object.values(p).some(f => fs.existsSync(f));
    if (!taken) return { stem, runIndex: n };
  }
  // 500 runs of one sequence is not a thing that happens; falling back to a
  // timestamp beats refusing to process.
  return { stem: `${base}_${Date.now()}`, runIndex: 500 };
}

// ── 1. Export ──
// Synchronous inside Premiere and it does activate the sequence, which is
// unavoidable: exportAsMediaDirect renders the *active* sequence.
async function exportSequence({ host, id, outPath, presetPath, workArea }) {
  const res = await host.exportAudio(id, outPath, presetPath, workArea ? 1 : 0);
  if (!res.ok) {
    const label = res.error === 'NO_PRESET' ? 'sin preset WAV'
      : res.error === 'NO_INOUT' ? 'marcá In y Out (I y O)'
        : 'error al exportar';
    return { ok: false, error: label, raw: res.error, debug: res.debug };
  }
  // Premiere may hand back a different extension than it was asked for, so the
  // path it reports wins over the one we chose.
  return { ok: true, outPath: res.outPath || outPath, inPoint: res.inPoint ?? 0, debug: res.debug };
}

// ── 2. Adobe Podcast, always at 100% ──
// The dry/wet blend belongs to the core (a 200 Hz band split, not a flat mix),
// so asking Adobe for anything but the pure clean voice would mean blending
// the same two signals twice in two different ways.
async function enhanceWithAdobe({ phonos, token, inPath, outPath, onProgress = () => {} }) {
  await phonos.enhanceToFile(inPath, outPath, {
    token,
    cleanVoice: 100,
    ffmpeg: null,
    codec: 'pcm_s24le',
    onStatus: (state, pct) => onProgress(state, pct),
  });
  return { ok: true, outPath };
}

// ── 3. Align Adobe's return to the original's clock ──
async function alignEnhanced({ aligner, originalPath, enhancedRawPath, outPath, onStatus, setCurrent }) {
  const res = await aligner.alignToOriginal(originalPath, enhancedRawPath, outPath, { onStatus, setCurrent });
  return { ok: true, outPath: res.outPath, note: res.note, shiftSec: res.shiftSec, correlation: res.correlation };
}

// ── 4. Place the clean voice on a new track ──
// In an In→Out run the other tracks are never muted: setMute silences a whole
// track, which would kill the rest of the timeline outside the region.
async function placeEnhanced({ host, id, wavPath, muteOthers, startSeconds, label, workArea }) {
  const effectiveMute = workArea ? 0 : (muteOthers ? 1 : 0);
  const res = await host.placeEnhanced(id, wavPath, effectiveMute, String(startSeconds ?? 0), label);
  if (!res.ok) return { ok: false, error: res.error, debug: res.debug };
  if (!res.nodeId) {
    // Without a nodeId there is no way to find this item again, so the relink
    // at the end would have nothing to point at. Better to say so now than to
    // master for ten minutes and fail at the last step.
    return { ok: false, error: 'Premiere no devolvió el nodeId del clip', debug: res.debug };
  }
  return { ok: true, nodeId: res.nodeId, track: res.track, debug: res.debug };
}

// ── 5. Master ──
async function masterSequence({ mastering, originalPath, enhancedPath, settings, sequenceName, onProgress, onNote, isCancelled, setCurrent }) {
  return mastering.masterOne({
    originalPath, enhancedPath, settings, sequenceName,
    onProgress, onNote, isCancelled, setCurrent,
  });
}

// ── 6. Relink ──
// Two gates before the clip is allowed to change:
//
//   mode 1 — the pair was rejected, so the master contains no Adobe pass at
//            all. Replacing the clip with it would silently undo the
//            enhancement the editor asked for (and paid credits for).
//   drift  — the master should be exactly as long as the original. If it is
//            not, something moved the audio, and relinking would put the
//            sequence out of sync for the rest of its life.
//
// A `warn` verify badge is NOT a gate: the loudness being a few tenths off is
// worth saying on the row, not worth withholding a finished master.
async function relinkMaster({ host, aligner, nodeId, originalPath, masterPath, mode, label, rename }) {
  if (mode === 1) {
    return { ok: false, blocked: 'PAIR_MISMATCH', error: 'el par con Adobe fue rechazado — no relinkeo' };
  }

  const sync = await aligner.masterMatchesOriginal(originalPath, masterPath);
  if (!sync.ok) {
    return { ok: false, blocked: 'SYNC', error: sync.reason, drift: sync.drift };
  }

  const res = await host.relinkMaster(nodeId, masterPath, label);
  if (!res.ok) return { ok: false, error: res.error, raw: res.error, debug: res.debug };

  if (rename) {
    // Cosmetic: makes the bin readable at a glance. Never a failure.
    try { await host.renameItem(nodeId, rename); } catch { /* ignore */ }
  }
  return { ok: true, path: res.path, drift: sync.drift, debug: res.debug };
}

module.exports = {
  exportSequence,
  enhanceWithAdobe,
  alignEnhanced,
  placeEnhanced,
  masterSequence,
  relinkMaster,
  dirsFor,
  pathsFor,
  nextStem,
  safeName,
  PATHS,
};
