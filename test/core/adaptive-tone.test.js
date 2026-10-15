'use strict';

// The tone stage used to be a fixed curve, so a source arriving 4 dB darker
// than another left 4 dB darker. These tests pin the adaptive behaviour: the
// correction must point the right way, scale with the measured deviation, do
// nothing at the reference (so the validated render is unchanged), and refuse
// to chase a source that is far outside what an EQ shelf should fix.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pipeline = require('../../plugin/core/pipeline');
const { runFfmpeg } = require('../../plugin/core/ffmpeg-run');
const fx = require('./fixtures');

const REF = pipeline.TONE_TILT_REFERENCE_DB;
const base = { hpfFrequency: 80 };
const gainFor = (tilt, settings = {}) => pipeline.tiltShelfGainDb({ tilt, flags: [] }, { ...base, ...settings });

test('a source at the reference gets no correction', () => {
  assert.equal(gainFor(REF), null);
});

test('a dark source is trimmed and a bright one is warmed', () => {
  const dark = gainFor(REF + 3);
  const bright = gainFor(REF - 3);
  assert.ok(dark < 0, `too much low end should cut, got ${dark}`);
  assert.ok(bright > 0, `too little low end should add, got ${bright}`);
  assert.ok(Math.abs(dark + bright) < 0.01, 'the correction should be symmetric around the reference');
});

test('the correction scales with how far off the source is', () => {
  const near = gainFor(REF + 1);
  const far = gainFor(REF + 3);
  assert.ok(Math.abs(far) > Math.abs(near));
  // A shelf moves tilt by TONE_TILT_DB_PER_SHELF_DB per dB, so a 3 dB excess
  // needs 3 / 0.65 dB of shelf to cancel it.
  assert.ok(Math.abs(far + 3 / pipeline.TONE_TILT_DB_PER_SHELF_DB) < 0.01);
});

test('the correction is capped so a broken source is not papered over', () => {
  for (const tilt of [REF + 40, REF - 40]) {
    const g = gainFor(tilt);
    assert.ok(Math.abs(g) <= pipeline.TONE_TILT_MAX_SHELF_DB,
      `${tilt} dB of tilt asked for ${g} dB of shelf, over the cap`);
  }
});

test('no measurement, an explicit opt-out, or a retargeted course are all respected', () => {
  assert.equal(pipeline.tiltShelfGainDb(null, base), null, 'a failed analysis must not guess');
  assert.equal(pipeline.tiltShelfGainDb({ tilt: null, flags: [] }, base), null);
  assert.equal(gainFor(REF + 3, { adaptiveToneEnabled: false }), null);
  // Retargeting moves the neutral point with it.
  assert.equal(gainFor(20, { toneTiltTarget: 20 }), null);
  assert.ok(gainFor(20, { toneTiltTarget: 14 }) < 0);
});

test('the shelf lands in the cuts chain, before the dynamics stage', () => {
  const chain = pipeline.buildEqCutsChain({ tilt: REF + 3, flags: [] }, base);
  assert.match(chain, /lowshelf=f=300:g=-/);
  assert.ok(chain.indexOf('highpass') < chain.indexOf('lowshelf'),
    'the HPF still runs first');
  assert.doesNotMatch(pipeline.buildEqCutsChain({ tilt: REF, flags: [] }, base), /lowshelf/);
});

test('the leveler stands down on already-dense material instead of flattening it', () => {
  const dense = { flags: [], loudness: { lra: 3.5 } };
  const dynamic = { flags: [], loudness: { lra: 8 } };
  assert.equal(pipeline.buildLevelerChain(dense, {}), null);
  const chain = pipeline.buildLevelerChain(dynamic, {});
  assert.ok(chain, 'material with real range should still be levelled');
  assert.match(chain, /ratio=2\b/, '3:1 on top of already-dense course audio squashed masters to ~2 LU');
  assert.equal(pipeline.buildLevelerChain(dynamic, { compressionMode: 'off' }), null);
});

// ── Render-level check ──
// Measuring the shelf's real effect, not just the string, because the whole
// point is the dB figure: the 0.65 dB-of-tilt-per-dB-of-shelf constant is
// what makes the correction land, and an ffmpeg change could move it.
let workDir;
let voice;

before(async () => {
  workDir = fx.tmpDir('tone');
  voice = await fx.buildClean(path.join(workDir, 'clean.wav'));
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

async function tiltAfter(chain) {
  const bandRms = async (band) => {
    const af = ['aformat=channel_layouts=mono', chain, band,
      'astats=measure_perchannel=RMS_level:measure_overall=none'].filter(Boolean).join(',');
    const e = await runFfmpeg(['-i', voice, '-af', af, '-f', 'null', '-'], { timeout: 120000 });
    const m = [...e.matchAll(/RMS level dB:\s*(-?[\d.]+)/g)];
    return parseFloat(m[m.length - 1][1]);
  };
  const [body, presence] = await Promise.all([
    bandRms('highpass=f=100:poles=2,lowpass=f=300:poles=2'),
    bandRms('highpass=f=2000:poles=2,lowpass=f=5000:poles=2'),
  ]);
  return body - presence;
}

test('the shelf moves tilt by the amount the correction assumes', async () => {
  const shelfDb = -4;
  const [before, after] = await Promise.all([
    tiltAfter(''),
    tiltAfter(`lowshelf=f=${300}:g=${shelfDb}`),
  ]);
  const movedPerDb = (before - after) / Math.abs(shelfDb);
  assert.ok(Math.abs(movedPerDb - pipeline.TONE_TILT_DB_PER_SHELF_DB) < 0.2,
    `a 300 Hz shelf moved tilt ${movedPerDb.toFixed(2)} dB per dB, ` +
    `but the correction assumes ${pipeline.TONE_TILT_DB_PER_SHELF_DB}`);
});

test('a dark source and a bright source converge instead of staying offset', async () => {
  // Same voice, pre-tilted two different ways: the correction should pull them
  // together. With the old fixed curve the gap survived untouched.
  //
  // The target is this fixture's own natural tilt rather than the shipped
  // reference: the synthetic voice is sine partials plus pink noise and sits
  // around 5 dB, nowhere near the ~14 dB real speech measures, so against the
  // shipped reference both variants would sit far below it, both would hit the
  // correction cap, and the gap would survive — the cap doing its job, but
  // testing nothing about convergence.
  const darken = 'lowshelf=f=300:g=3';
  const brighten = 'lowshelf=f=300:g=-3';
  const target = await tiltAfter('');

  const darkTilt = await tiltAfter(darken);
  const brightTilt = await tiltAfter(brighten);
  const gapBefore = Math.abs(darkTilt - brightTilt);

  const correct = (tilt) => {
    const g = pipeline.tiltShelfGainDb({ tilt, flags: [] }, { ...base, toneTiltTarget: target });
    return g == null ? '' : `lowshelf=f=300:g=${g.toFixed(2)}`;
  };
  const darkAfter = await tiltAfter([darken, correct(darkTilt)].filter(Boolean).join(','));
  const brightAfter = await tiltAfter([brighten, correct(brightTilt)].filter(Boolean).join(','));
  const gapAfter = Math.abs(darkAfter - brightAfter);

  assert.ok(gapAfter < gapBefore * 0.5,
    `tonal spread should shrink: ${gapBefore.toFixed(1)} dB before, ${gapAfter.toFixed(1)} dB after`);
  for (const [label, t] of [['dark', darkAfter], ['bright', brightAfter]]) {
    assert.ok(Math.abs(t - target) < Math.abs((label === 'dark' ? darkTilt : brightTilt) - target),
      `the ${label} source should end up closer to the target, not further`);
  }
});
