'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runFusion, buildFusionGraph } = require('../../plugin/core/fusion');
const { runFfprobe } = require('../../plugin/core/ffmpeg-run');
const fx = require('./fixtures');

let workDir, originalPath, enhancedPath;

before(async () => {
  workDir = fx.tmpDir('fusion');
  originalPath = await fx.buildTone(path.join(workDir, 'original.wav'), { duration: 3, frequency: 180, peakDb: -14 });
  enhancedPath = await fx.buildTone(path.join(workDir, 'enhanced.wav'), { duration: 3, frequency: 180, peakDb: -20 });
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

async function probeDuration(p) {
  const out = await runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_format', p]);
  return parseFloat(JSON.parse(out).format.duration);
}

test('buildFusionGraph: bands mode crosses over at the configured frequency', () => {
  const graph = buildFusionGraph({ fusionMode: 'bands', fusionCrossoverHz: 250 });
  assert.match(graph, /acrossover=split=250:order=4th/);
  assert.match(graph, /\[out\]$/);
});

test('buildFusionGraph: bed mode mixes with the clamped original weight', () => {
  const graph = buildFusionGraph({ fusionMode: 'bed', fusionOriginalPct: 30 });
  assert.match(graph, /amix=inputs=2:weights=1 0\.300/);
});

test('buildFusionGraph: bed weight is clamped to the documented max (40%)', () => {
  const graph = buildFusionGraph({ fusionMode: 'bed', fusionOriginalPct: 999 });
  assert.match(graph, /weights=1 0\.400/);
});

test('buildFusionGraph: bands_bed adds a bed only when weight > 0', () => {
  const zero = buildFusionGraph({ fusionMode: 'bands_bed', fusionOriginalPct: 0 });
  assert.doesNotMatch(zero, /\[bands\]/);
  const some = buildFusionGraph({ fusionMode: 'bands_bed', fusionOriginalPct: 15 });
  assert.match(some, /\[bands\]/);
});

test('runFusion (bands): produces a playable file matching source duration', async () => {
  const outPath = path.join(workDir, 'fused-bands.wav');
  await runFusion(originalPath, enhancedPath, outPath, { fusionMode: 'bands', fusionCrossoverHz: 200 });
  assert.ok(fs.existsSync(outPath));
  const dur = await probeDuration(outPath);
  assert.ok(Math.abs(dur - 3) < 0.15, `duration ${dur} should be ~3s`);
});

test('runFusion (bed): produces a playable file matching source duration', async () => {
  const outPath = path.join(workDir, 'fused-bed.wav');
  await runFusion(originalPath, enhancedPath, outPath, { fusionMode: 'bed', fusionOriginalPct: 20 });
  assert.ok(fs.existsSync(outPath));
  const dur = await probeDuration(outPath);
  assert.ok(Math.abs(dur - 3) < 0.15, `duration ${dur} should be ~3s`);
});

test('runFusion (bands_bed): produces a playable file matching source duration', async () => {
  const outPath = path.join(workDir, 'fused-bands-bed.wav');
  await runFusion(originalPath, enhancedPath, outPath, { fusionMode: 'bands_bed', fusionOriginalPct: 15, fusionCrossoverHz: 200 });
  assert.ok(fs.existsSync(outPath));
  const dur = await probeDuration(outPath);
  assert.ok(Math.abs(dur - 3) < 0.15, `duration ${dur} should be ~3s`);
});
