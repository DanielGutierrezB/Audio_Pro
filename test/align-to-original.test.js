'use strict';

// Real ffmpeg, real audio. This is the one piece of the panel where a unit
// test with stubs would prove nothing: the claim is "the enhanced file ends up
// occupying exactly the same span as the original", and only ffmpeg can say
// whether that is true.
//
// The fixture is the actual failure this stage exists for: Adobe Podcast trims
// leading silence, so what comes back starts earlier and is shorter. Feeding
// that pair to the pipeline unmodified makes it trim the ORIGINAL to match,
// and in Premiere the original is the clock — the master would land early by
// exactly the amount of silence that was trimmed, silently.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aligner = require('../plugin/js/align-to-original');
const align = require('../plugin/core/align');
const { buildSpeechLike } = require('./speech-fixture');

const HEAD_SILENCE_SEC = 3;

let workDir;

before(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-align-')); });
after(() => { if (workDir) fs.rmSync(workDir, { recursive: true, force: true }); });

test('an Adobe return with its head trimmed is pushed back onto the original\'s clock', async () => {
  const original = await buildSpeechLike(path.join(workDir, 'original.wav'), { silenceHead: HEAD_SILENCE_SEC });
  // What Adobe gives back: the same take with the leading silence gone.
  const enhanced = await buildSpeechLike(path.join(workDir, 'enhanced.raw.wav'), { silenceHead: 0 });
  const out = path.join(workDir, 'aligned.wav');

  const origDur = await aligner.durationOf(original);
  const enhDur = await aligner.durationOf(enhanced);
  assert.ok(origDur - enhDur > 2.5, `fixture should be ~${HEAD_SILENCE_SEC}s apart, was ${(origDur - enhDur).toFixed(2)}s`);

  const res = await aligner.alignToOriginal(original, enhanced, out);

  assert.equal(res.note, 'REALIGNED');
  assert.ok(res.confident, `correlation was ${res.correlation}`);
  assert.ok(
    Math.abs(res.shiftSec - HEAD_SILENCE_SEC) < 0.2,
    `should have found the ${HEAD_SILENCE_SEC}s offset, found ${res.shiftSec.toFixed(2)}s`,
  );

  // The point of the whole stage: same length as the original, within a frame.
  const alignedDur = await aligner.durationOf(out);
  assert.ok(
    Math.abs(alignedDur - origDur) <= aligner.DURATION_TOLERANCE_SEC,
    `aligned ${alignedDur.toFixed(3)}s vs original ${origDur.toFixed(3)}s`,
  );
});

test('a pair that already matches is normalised but not shifted', async () => {
  const original = await buildSpeechLike(path.join(workDir, 'same-orig.wav'));
  const enhanced = await buildSpeechLike(path.join(workDir, 'same-enh.wav'));
  const out = path.join(workDir, 'same-aligned.wav');

  const res = await aligner.alignToOriginal(original, enhanced, out);

  assert.equal(res.shiftSec, 0);
  assert.equal(res.note, null, 'nothing to report when the durations already agree');
  const dur = await aligner.durationOf(out);
  assert.ok(Math.abs(dur - res.duration) < 0.01);
});

test('a shorter return is padded to length rather than left short', async () => {
  const original = await buildSpeechLike(path.join(workDir, 'long.wav'), { duration: 8 });
  const enhanced = await buildSpeechLike(path.join(workDir, 'short.wav'), { duration: 6 });
  const out = path.join(workDir, 'padded.wav');

  const res = await aligner.alignToOriginal(original, enhanced, out);

  const origDur = await aligner.durationOf(original);
  const alignedDur = await aligner.durationOf(out);
  assert.ok(
    Math.abs(alignedDur - origDur) <= aligner.DURATION_TOLERANCE_SEC,
    `padded to ${alignedDur.toFixed(3)}s, original is ${origDur.toFixed(3)}s`,
  );
  assert.ok(res.ok);
});

test('a confident but implausibly large shift is flagged, not mastered unattended', async () => {
  // A 45-second "offset" is not Adobe trimming silence, it is a different
  // recording. align.js can still be confident about it, so the gate has to
  // be the size: such a pair must come back as PAIR?, never as PADDED.
  const real = align.estimateOffset;
  align.estimateOffset = async () => ({ offsetSec: 45, correlation: 0.9, contrast: 0.5, confident: true });
  try {
    const original = await buildSpeechLike(path.join(workDir, 'far-orig.wav'), { duration: 8 });
    const enhanced = await buildSpeechLike(path.join(workDir, 'far-enh.wav'), { duration: 6 });
    const res = await aligner.alignToOriginal(original, enhanced, path.join(workDir, 'far-out.wav'));
    assert.equal(res.note, 'PAIR?');
    assert.equal(res.shiftSec, 0, 'an implausible shift is not applied');
  } finally {
    align.estimateOffset = real;
  }
});

test('buildFilter picks delay or trim by sign, and always pads the tail', () => {
  assert.match(aligner.buildFilter(3), /adelay=delays=3000:all=1/);
  assert.match(aligner.buildFilter(-1.5), /atrim=start=1\.500/);
  // Below the negligible threshold nothing is shifted — ffmpeg's own sample
  // rounding lives down there and a re-render would be noise, not a fix.
  assert.equal(aligner.buildFilter(0.001), 'apad');
  assert.match(aligner.buildFilter(0), /^apad$/);
  for (const shift of [3, -1.5, 0]) {
    assert.match(aligner.buildFilter(shift), /apad$/, 'the tail is always padded/cut to length');
  }
});

test('masterMatchesOriginal is the gate that stops a desynced relink', async () => {
  const original = await buildSpeechLike(path.join(workDir, 'gate-orig.wav'), { duration: 6 });
  const sameLength = await buildSpeechLike(path.join(workDir, 'gate-master.wav'), { duration: 6 });
  const tooShort = await buildSpeechLike(path.join(workDir, 'gate-short.wav'), { duration: 4 });

  const good = await aligner.masterMatchesOriginal(original, sameLength);
  assert.ok(good.ok, `drift was ${good.drift}`);

  const bad = await aligner.masterMatchesOriginal(original, tooShort);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /dura/);
});
