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
const { runFfmpeg } = require('../plugin/core/ffmpeg-run');

const HEAD_SILENCE_SEC = 3;
const SPEECH_SEC = 6;

let workDir;

before(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-align-')); });
after(() => { if (workDir) fs.rmSync(workDir, { recursive: true, force: true }); });

// Speech-ish rather than a steady tone on purpose: align.js refuses to trust a
// correlation computed from a flat envelope (every lag "matches" a constant
// tone equally well), so a sine fixture would exercise the refusal path
// instead of the alignment path.
async function buildSpeechLike(outPath, { silenceHead = 0, duration = SPEECH_SEC } = {}) {
  const words = [];
  for (let i = 0; i < Math.floor(duration); i++) {
    // alternating loud/quiet seconds = an envelope with shape
    words.push(`sine=frequency=${180 + (i % 3) * 40}:duration=0.6`, 'anullsrc=duration=0.4:r=48000');
  }
  const inputs = words.map(w => ['-f', 'lavfi', '-i', w]).flat();
  const concat = words.map((_, i) => `[${i}:a]`).join('') + `concat=n=${words.length}:v=0:a=1[speech]`;
  const head = silenceHead > 0
    ? `;[speech]adelay=delays=${silenceHead * 1000}:all=1[out]`
    : ';[speech]acopy[out]';

  await runFfmpeg([
    '-y', ...inputs,
    '-filter_complex', concat + head,
    '-map', '[out]',
    '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '1',
    outPath,
  ], { timeout: 120000 });
  return outPath;
}

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
