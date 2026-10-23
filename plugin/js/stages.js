'use strict';

// ── The Premiere-facing stages and the on-disk layout ───────────────────
// The three stages that talk to Premiere (export, place, relink) carry policy
// of their own — which errors mean what, when not to mute, when a finished
// master must NOT replace the clip — so they live here instead of inline in
// the queue. The other three stages are a single call each (phonos,
// align-to-original, mastering) and the queue makes them directly.
//
// Every function takes its collaborators as arguments, which is what lets
// test/queue.test.js drive the whole machine with Premiere stubbed out.
//
// Each returns { ok, error } rather than throwing; `error` is already the
// sentence the row shows.

const path = require('path');
const fs = require('fs');

const exportWait = require('./export-wait');

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

// A region as whole seconds that cover it: the start rounded down, the end
// rounded up, so 7:39.6–7:40.8 reads 7:39–7:41 and never looks shorter than
// it is. Minutes are not wrapped at 60, because classes run past an hour.
function regionParts(region) {
  const whole = (sec) => [Math.floor(sec / 60), String(sec % 60).padStart(2, '0')];
  return [whole(Math.max(0, Math.floor(region.in))), whole(Math.max(0, Math.ceil(region.out)))];
}

// "7m39s-7m41s" — for file names: no colons, which not every filesystem allows.
function regionStem(region) {
  return regionParts(region).map(([m, s]) => `${m}m${s}s`).join('-');
}

// "1:20.6" — a timeline position to the tenth, for telling the editor exactly
// where something landed.
function timecode(sec) {
  const tenths = Math.round(Math.max(0, Number(sec) || 0) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

// "7:39–7:41" — for the row.
function regionText(region) {
  return regionParts(region).map(([m, s]) => `${m}:${s}`).join('–');
}

// The name every file of a run starts from. A whole-sequence run is named after
// the sequence; an In→Out run also carries its region, so two patches of the
// same class can be told apart by name — on disk and in the bin — and a patch
// is never mistaken for the class.
function stemBase(item) {
  const base = safeName(item.name);
  if (item.region) return `${base}_inout_${regionStem(item.region)}`;
  return item.workArea ? `${base}_inout` : base;
}

// A re-run must never overwrite a file a project item is pointing at: Premiere
// keeps the media open, the clip on the timeline would silently change under
// the editor, and the previous master — which may be the good one — is gone.
// So each run gets its own stem: `clase`, then `clase_2`, `clase_3`.
function nextStem(dirs, base) {
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
// It activates the sequence, which is unavoidable: exportAsMediaDirect renders
// the *active* one. host.jsx starts the export and returns at once with the
// duration the result must have; this then waits — from Node, so Premiere's
// main thread stays free to write — until the file really holds it (see
// export-wait.js for why the old wait cut classes to a minute). The caller
// runs this inside the Premiere lane, so nothing else talks to Premiere until
// the export is whole.
async function exportSequence({ host, id, outPath, presetPath, workArea, region, onProgress, pollMs, stallMs }) {
  const res = await host.exportAudio(id, outPath, presetPath, workArea ? 1 : 0, region?.in, region?.out);
  if (!res.ok) {
    const label = res.error === 'NO_PRESET' ? 'sin preset WAV'
      : res.error === 'NO_INOUT' ? 'marcá In y Out (I y O)'
        : res.error === 'INOUT_CHANGED' ? 'las marcas In/Out cambiaron desde que tocaste el botón — volvé a tocar In → Out'
          : 'error al exportar';
    return { ok: false, error: label, raw: res.error, debug: res.debug };
  }
  const written = await exportWait.waitForExport({
    requestedPath: res.outPath || outPath,
    expectedSeconds: res.expectedSeconds,
    onProgress,
    pollMs,
    stallMs,
  });
  if (!written.ok) return { ok: false, error: written.error, debug: res.debug };
  return {
    ok: true,
    outPath: written.outPath,
    inPoint: res.inPoint ?? 0,
    expectedSeconds: res.expectedSeconds ?? null,
    duration: written.duration,
    verified: written.verified,
    debug: res.debug,
  };
}

// ── 4. Place the clean voice on a new track ──
// In an In→Out run the other tracks are never muted: setMute silences a whole
// track, which would kill the rest of the timeline outside the region. And the
// patch always gets a brand-new track appended at the end (with A1–A3 in use,
// A4), never a track that already existed.
async function placeEnhanced({ host, id, wavPath, muteOthers, startSeconds, label, workArea }) {
  const effectiveMute = workArea ? 0 : (muteOthers ? 1 : 0);
  const placement = workArea ? 'new' : 'auto';
  const res = await host.placeEnhanced(id, wavPath, effectiveMute, String(startSeconds ?? 0), label, placement);
  if (!res.ok) return { ok: false, error: res.error, debug: res.debug };
  if (!res.nodeId) {
    // Without a nodeId there is no way to find this item again, so the relink
    // at the end would have nothing to point at. Better to say so now than to
    // master for ten minutes and fail at the last step.
    return { ok: false, error: 'Premiere no devolvió el nodeId del clip', debug: res.debug };
  }
  return { ok: true, nodeId: res.nodeId, track: res.track, placedAt: res.placedAt ?? null, debug: res.debug };
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
    return {
      ok: false,
      blocked: 'PAIR_MISMATCH',
      error: 'el par con Adobe fue rechazado: el master no lleva la voz limpia, lo dejo sin relinkear',
    };
  }

  const sync = await aligner.masterMatchesOriginal(originalPath, masterPath);
  if (!sync.ok) {
    return { ok: false, blocked: 'SYNC', error: `sincronía: ${sync.reason} — no relinkeo`, drift: sync.drift };
  }

  const res = await host.relinkMaster(nodeId, masterPath, label);
  if (res.error === 'NODE_NOT_FOUND') {
    return { ok: false, lost: true, error: 'el clip ya no está en el proyecto — reintentá para volver a colocarlo' };
  }
  if (!res.ok) return { ok: false, error: 'relink: ' + res.error, debug: res.debug };

  if (rename) {
    // Cosmetic: makes the bin readable at a glance. Never a failure.
    try { await host.renameItem(nodeId, rename); } catch { /* ignore */ }
  }
  return { ok: true, path: res.path, drift: sync.drift, debug: res.debug };
}

module.exports = {
  exportSequence,
  placeEnhanced,
  relinkMaster,
  dirsFor,
  pathsFor,
  nextStem,
  stemBase,
  regionText,
  timecode,
  safeName,
  PATHS,
};
