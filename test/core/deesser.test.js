'use strict';

// The de-esser and the air shelf are the two stages that decide how clear a
// finished class sounds, and both were silently inverted up to v0.7.0: the
// de-esser attenuated 5-9 kHz unconditionally (adynamicequalizer mode=0 is
// `cutbelow`, and its `threshold` is linear amplitude, so the configured 15
// was above full scale), while NO_AIR fired on every real voice and so the
// air shelf never applied. The flag-level suite in metrics.test.js passed
// throughout, because it only ever asserted that a detector fires — never
// what the render does to the bands afterwards. These tests close that gap.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pipeline = require('../../plugin/core/pipeline');
const metrics = require('../../plugin/core/metrics');
const { runFfmpeg } = require('../../plugin/core/ffmpeg-run');
const fx = require('./fixtures');

const BANDS = {
  presence: 'highpass=f=2000:poles=2,lowpass=f=5000:poles=2',
  sibilance: 'highpass=f=5000:poles=2,lowpass=f=9000:poles=2',
};

// RMS of one band after running `chain` (may be empty) over the file.
async function bandRms(file, chain, band) {
  const af = ['aformat=channel_layouts=mono', chain, band,
    'astats=measure_perchannel=RMS_level:measure_overall=none'].filter(Boolean).join(',');
  const stderr = await runFfmpeg(['-i', file, '-af', af, '-f', 'null', '-'], { timeout: 120000 });
  const m = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+)/g)];
  assert.ok(m.length, 'astats printed no RMS level');
  return parseFloat(m[m.length - 1][1]);
}

let workDir;
const files = {};

before(async () => {
  workDir = fx.tmpDir('deesser');
  files.esses = await fx.buildSibilantPeaks(path.join(workDir, 'ess-peaks.wav'), workDir);
  files.clean = await fx.buildClean(path.join(workDir, 'clean.wav'));
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('de-esser cuts sibilance without taking presence with it', async () => {
  const chain = pipeline.buildDeesserChain(null, { deEsserAmount: 60 });
  assert.ok(chain, 'a 60% de-esser should produce a chain');

  const [presBefore, presAfter] = await Promise.all([
    bandRms(files.esses, '', BANDS.presence),
    bandRms(files.esses, chain, BANDS.presence),
  ]);
  const [sibBefore, sibAfter] = await Promise.all([
    bandRms(files.esses, '', BANDS.sibilance),
    bandRms(files.esses, chain, BANDS.sibilance),
  ]);

  const dPres = presAfter - presBefore;
  const dSib = sibAfter - sibBefore;

  assert.ok(dSib < -3, `expected real sibilance reduction, got ${dSib.toFixed(1)} dB`);
  // The old chain took 17.5 dB out of sibilance and 6 dB out of presence on a
  // real class. Some presence movement is unavoidable here: a bell centred at
  // 7.5 kHz bleeds through the 2-pole skirt of a band that ends at 5 kHz, and
  // the synthetic burst sits partly inside that skirt. On real audio the same
  // setting costs 0.7 dB.
  assert.ok(dPres > -2.5, `presence should survive, lost ${dPres.toFixed(1)} dB`);
  assert.ok(dSib < dPres - 3,
    `sibilance (${dSib.toFixed(1)} dB) must be cut clearly harder than presence (${dPres.toFixed(1)} dB)`);
});

test('de-esser is level-independent (it runs before loudnorm)', async () => {
  const chain = pipeline.buildDeesserChain(null, { deEsserAmount: 60 });
  const reductionAt = async (gainDb) => {
    const pre = `volume=${gainDb}dB`;
    const before = await bandRms(files.esses, pre, BANDS.sibilance);
    const after = await bandRms(files.esses, `${pre},${chain}`, BANDS.sibilance);
    return after - before;
  };
  const [quiet, loud] = await Promise.all([reductionAt(-12), reductionAt(12)]);
  // A fixed threshold used to swing from -0.3 dB on a quiet take to -4.2 dB
  // on a loud one; auto=adaptive tracks the signal instead of the meter.
  assert.ok(Math.abs(quiet - loud) < 1.5,
    `reduction should not depend on input level: ${quiet.toFixed(1)} dB quiet vs ${loud.toFixed(1)} dB loud`);
});

test('de-esser intensity scales the maximum reduction, and 0 disables the stage', () => {
  assert.equal(pipeline.buildDeesserChain(null, { deEsserAmount: 0 }), null);
  const rangeOf = (amt) => {
    const chain = pipeline.buildDeesserChain(null, { deEsserAmount: amt });
    return parseFloat(chain.match(/range=([\d.]+)/)[1]);
  };
  assert.ok(rangeOf(100) > rangeOf(50), 'a louder setting must allow more reduction');
  assert.ok(rangeOf(50) > rangeOf(10));
});

test('de-esser never uses the inverted cutbelow mode or a linear-scale threshold', () => {
  const chain = pipeline.buildDeesserChain(null, { deEsserAmount: 60 });
  // mode=1 is cutabove; mode=0 is cutbelow, which attenuates everything
  // except the esses. auto=4 is adaptive. Numeric because the named
  // spellings are rejected by older ffmpeg builds — see src/pipeline.js.
  assert.match(chain, /mode=1\b/, 'mode=0 (cutbelow) attenuates everything except the esses');
  assert.match(chain, /auto=4\b/, 'without adaptive the threshold is a fixed level');
  assert.doesNotMatch(chain, /threshold=/,
    'a manual threshold is linear amplitude here and breaks as soon as input level changes');
});

test('de-esser engages on measured sibilance even when the slider is at 0', () => {
  const qc = { flags: [{ code: 'SIBILANT' }] };
  assert.ok(pipeline.buildDeesserChain(qc, { deEsserAmount: 0 }));
  assert.equal(pipeline.buildDeesserChain({ flags: [] }, { deEsserAmount: 0 }), null);
});

test('de-esser honours the pre-slider on/off flag', () => {
  assert.ok(pipeline.buildDeesserChain(null, { deEsserEnabled: true }));
  assert.equal(pipeline.buildDeesserChain({ flags: [] }, { deEsserEnabled: false }), null);
});

test('exciter intensity scales amount and blend, and 0 disables the stage', () => {
  assert.equal(pipeline.buildExciterChain({ airExtraAmount: 0 }), null);
  const amountOf = (amt) => parseFloat(
    pipeline.buildExciterChain({ airExtraAmount: amt }).match(/amount=([\d.]+)/)[1]);
  assert.ok(amountOf(100) > amountOf(50));
  assert.ok(amountOf(50) > amountOf(10));
  assert.ok(pipeline.buildExciterChain({ airExtraEnabled: true }), 'pre-slider flag still works');
});

test('normal voice keeps its air shelf (NO_AIR is for genuinely dull sources)', async () => {
  const qc = await metrics.analyzeFile(files.clean);
  const codes = qc.flags.map(f => f.code);
  assert.ok(!codes.includes('NO_AIR'),
    `broadband material must not be called band-limited, got ${codes}`);
  assert.ok(!codes.includes('SIBILANT'),
    `clean voice must not be called sibilant, got ${codes}`);
});
