'use strict';

// ── Putting Adobe's return back on the sequence's clock ─────────────────
//
// This stage exists because of a conflict between what the pipeline does and
// what Premiere needs.
//
// Adobe Podcast trims leading and trailing silence on its own, so what comes
// back is usually the same take shifted earlier and a bit shorter. The core's
// align.js already detects that and fixes it — by trimming the head off
// whichever file starts later, which in practice is **the original**
// (plugin/core/pipeline.js, the PAIR_REALIGNED branch).
//
// That is the right call for a folder of files, where nothing anchors them to
// a clock. It is the wrong call here. In Premiere the original *is* the clock:
// it was exported from the sequence, and the clip is placed at a known
// position on the timeline. Trim its head and the master ends up early by
// exactly that much, silently, in sync with nothing — the failure mode
// audio_education/docs/PREMIERE-INTEGRATION.md §13.1 calls the easiest mistake
// to make and the hardest to notice in a quick listen.
//
// So the panel does the opposite, before the pipeline ever sees the pair: pad
// or trim the **enhanced** file until it occupies exactly the same span as the
// original. Two things follow from that:
//
//   - The enhanced clip placed on the timeline at step 4 is already in sync,
//     so the editor can work with it immediately.
//   - The pipeline receives two files of equal duration, takes the
//     `durOk` path, and never reaches the branch that would trim the original.
//     Nothing in core/ had to change for this.
//
// The whole adjustment is one ffmpeg pass: adelay or atrim for the head, apad
// plus `-t` for the tail. `-t` is what makes the duration exact rather than
// approximately right.

const path = require('path');
const fs = require('fs');

const align = require('../core/align');
const { runFfmpeg, runFfprobe } = require('../core/ffmpeg-run');

// Below this the offset is not worth a re-render: ffmpeg's own sample
// rounding lives down here, and a 10 ms shift is inaudible and invisible on
// the timeline.
const NEGLIGIBLE_SEC = 0.02;
// How closely the result has to match the original. One video frame at 24 fps
// is 41 ms; anything inside 50 ms cannot be seen or heard against picture.
const DURATION_TOLERANCE_SEC = 0.05;
// Past this a "shift" is not a trim, it is a different recording. align.js
// already refuses to be confident about those, but a confident answer this
// large is also suspect.
const MAX_PLAUSIBLE_SHIFT_SEC = 30;

const ALIGN_TIMEOUT_MS = 10 * 60 * 1000;

async function durationOf(filePath) {
  const out = await runFfprobe([
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
  ]);
  const d = parseFloat(JSON.parse(out).format?.duration);
  return Number.isFinite(d) ? d : null;
}

// One pass: head correction, then pad/cut to length.
//
// shiftSec > 0 means the enhanced file is missing that much from its head, so
// silence goes back in front of it. < 0 means it has extra head to drop.
function buildFilter(shiftSec) {
  const parts = [];
  if (shiftSec > NEGLIGIBLE_SEC) {
    parts.push(`adelay=delays=${Math.round(shiftSec * 1000)}:all=1`);
  } else if (shiftSec < -NEGLIGIBLE_SEC) {
    parts.push(`atrim=start=${(-shiftSec).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
  }
  // apad + -t: pad covers an enhanced file that came back shorter (Adobe also
  // trims the tail), -t cuts one that came back longer. Together they make
  // the output exactly as long as the original rather than roughly so.
  parts.push('apad');
  return parts.join(',');
}

async function render(enhancedPath, outPath, shiftSec, targetDuration, opts = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await runFfmpeg([
    '-y',
    '-i', enhancedPath,
    '-af', buildFilter(shiftSec),
    '-t', targetDuration.toFixed(3),
    '-c:a', 'pcm_s24le',
    '-ar', '48000',
    '-ac', '1',
    outPath,
  ], { timeout: ALIGN_TIMEOUT_MS, ...opts });
  return outPath;
}

// Writes `outPath`: Adobe's return, occupying exactly the original's span.
//
// Returns { ok, outPath, shiftSec, correlation, confident, duration, note }.
// `note` is what the row shows:
//   null             — nothing to report, durations already matched
//   'REALIGNED'      — a confident offset was found and corrected
//   'PADDED'         — no offset, but the lengths differed; padded/cut to fit
//   'PAIR?'          — the durations disagree and no plausible offset explains
//                      it (none found with confidence, or one too large to be
//                      a trim). The file is still produced and still placed, because a
//                      suspicious pair is not a reason to throw away an Adobe
//                      pass the user paid credits for — but the caller should
//                      not master it unattended.
async function alignToOriginal(originalPath, enhancedPath, outPath, { setCurrent } = {}) {
  const [origDur, enhDur] = await Promise.all([
    durationOf(originalPath),
    durationOf(enhancedPath),
  ]);
  if (origDur == null || enhDur == null) {
    throw new Error('no pude medir la duración del par (¿archivo corrupto?)');
  }

  // Same length already means Adobe trimmed nothing, so there is no offset to
  // look for. The file is still re-rendered rather than copied, so that what
  // reaches the pipeline is always 24-bit/48k/mono whatever Adobe returned.
  const sameLength = Math.abs(origDur - enhDur) <= DURATION_TOLERANCE_SEC;
  const shift = sameLength
    ? { offsetSec: 0, correlation: null, confident: true }
    : await align.estimateOffset(originalPath, enhancedPath);

  // estimateOffset reports how far the enhanced sits from the original:
  // positive means it starts later in the take, i.e. its head was trimmed.
  // That is also the amount of silence it needs back.
  const shiftSec = shift.offsetSec ?? 0;
  // A confident answer this large is still not a trim, it is a different
  // recording — so it counts as unusable, exactly like an unconfident one.
  const usable = shift.confident && Math.abs(shiftSec) <= MAX_PLAUSIBLE_SHIFT_SEC;

  await render(enhancedPath, outPath, usable ? shiftSec : 0, origDur, { setCurrent });

  const finalDur = await durationOf(outPath);
  if (finalDur == null || Math.abs(finalDur - origDur) > DURATION_TOLERANCE_SEC) {
    throw new Error(
      `la alineación no cuadró: ${finalDur?.toFixed(2)}s vs ${origDur.toFixed(2)}s del original`,
    );
  }

  let note = null;
  if (!usable) note = 'PAIR?';
  else if (Math.abs(shiftSec) > NEGLIGIBLE_SEC) note = 'REALIGNED';
  else if (!sameLength) note = 'PADDED';

  return {
    ok: true,
    outPath,
    shiftSec: usable ? shiftSec : 0,
    correlation: shift.correlation ?? null,
    confident: !!shift.confident,
    duration: finalDur,
    note,
  };
}

// Last gate before the relink. The master should be the original's length —
// nothing in the chain changes duration once trimSilence is off — so a
// mismatch here means something upstream did move the audio, and relinking a
// clip to it would put the whole sequence out of sync.
async function masterMatchesOriginal(originalPath, masterPath) {
  const [origDur, masterDur] = await Promise.all([
    durationOf(originalPath),
    durationOf(masterPath),
  ]);
  if (origDur == null || masterDur == null) {
    return { ok: false, reason: 'no pude medir las duraciones', origDur, masterDur };
  }
  const drift = Math.abs(origDur - masterDur);
  // Twice the alignment tolerance: the master went through two more ffmpeg
  // passes than the aligned pair did, each of which can round by a sample or
  // two, and this check is about catching a real shift, not accumulated
  // rounding.
  const limit = DURATION_TOLERANCE_SEC * 2;
  return {
    ok: drift <= limit,
    drift,
    origDur,
    masterDur,
    reason: drift <= limit ? null
      : `el master dura ${masterDur.toFixed(2)}s y el original ${origDur.toFixed(2)}s`,
  };
}

module.exports = {
  alignToOriginal,
  masterMatchesOriginal,
  durationOf,
  buildFilter,
  NEGLIGIBLE_SEC,
  DURATION_TOLERANCE_SEC,
  MAX_PLAUSIBLE_SHIFT_SEC,
};
