'use strict';

// ── Mode 2 fusion ──────────────────────────────────────────────────────
// Blends an original recording with its 100%-strength Adobe Podcast
// Enhance Speech counterpart into a single intermediate file, which then
// runs through the same analyze → repair → EQ → loudness pipeline as any
// Mode 1 file. Isolating the two-input step into its own render keeps
// the rest of pipeline.js single-input, which is what most of its
// filters (and the measure/render two-pass loudnorm dance) assume.
//
// Strategies:
//   bands      (default) — crossover split at `fusionCrossoverHz`: low end
//               from the original (body/room tone that heavy denoisers
//               tend to thin out), everything above from the enhanced
//               track (denoised, de-reverbed).
//   bed        — enhanced track at full strength, with a low-level
//               `fusionOriginalPct` bed of the original mixed underneath
//               for room/breath naturalness.
//   bands_bed  — bands fusion, then an extra light original bed on top.

const { runFfmpeg } = require('./ffmpeg-run');

const FUSION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CROSSOVER_HZ = 200;
const MAX_BED_PCT = 40;

function clampBedWeight(pct) {
  const bounded = Math.max(0, Math.min(MAX_BED_PCT, pct ?? 20));
  return bounded / 100;
}

function buildFusionGraph(settings) {
  const mode = settings.fusionMode ?? 'bands';
  const crossoverHz = settings.fusionCrossoverHz ?? DEFAULT_CROSSOVER_HZ;
  const bedWeight = clampBedWeight(settings.fusionOriginalPct);

  if (mode === 'bed') {
    return `[1:a]aformat=channel_layouts=mono[e];[0:a]aformat=channel_layouts=mono[o];` +
      `[e][o]amix=inputs=2:weights=1 ${bedWeight.toFixed(3)}:normalize=0[out]`;
  }

  const bandsGraph =
    `[0:a]aformat=channel_layouts=mono,acrossover=split=${crossoverHz}:order=4th[olo][ohi];` +
    `[1:a]aformat=channel_layouts=mono,acrossover=split=${crossoverHz}:order=4th[elo][ehi];` +
    `[ohi]anullsink;[elo]anullsink;` +
    `[olo][ehi]amix=inputs=2:normalize=0`;

  if (mode === 'bands_bed' && bedWeight > 0) {
    return `${bandsGraph}[bands];[0:a]aformat=channel_layouts=mono[o2];` +
      `[bands][o2]amix=inputs=2:weights=1 ${bedWeight.toFixed(3)}:normalize=0[out]`;
  }
  return `${bandsGraph}[out]`;
}

async function runFusion(originalPath, enhancedPath, outPath, settings, opts = {}) {
  const graph = buildFusionGraph(settings);
  await runFfmpeg([
    '-y',
    '-i', originalPath,
    '-i', enhancedPath,
    '-filter_complex', graph,
    '-map', '[out]',
    '-acodec', 'pcm_s24le', '-ar', '48000',
    outPath,
  ], { ...opts, timeout: opts.timeout ?? FUSION_TIMEOUT_MS });
  return outPath;
}

module.exports = { runFusion, buildFusionGraph };
