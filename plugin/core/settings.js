'use strict';

// ── Settings schema and validation ──────────────────────────────────────
// Every value here arrives from the renderer over IPC, so this is a trust
// boundary, not a convenience check: `manualEqChain` is spliced straight into
// an FFmpeg filter graph and `customOutputDir` becomes a write target.
//
// No Electron dependency — `validate` is a pure function so the boundary can
// actually be tested.

const path = require('path');
const { DELIVERY_PRESETS, DEFAULT_PRESET } = require('./presets');

const DEFAULTS = {
  hpfFrequency: 80,
  deEsserEnabled: false,
  outputFormat: 'wav24',
  sampleRate: 48000,
  showNotifications: true,
  // Manual EQ override (FFmpeg filter chain string + on/off flag). When
  // manualEqApply is true the pipeline uses manualEqChain in place of the
  // built-in base EQ.
  manualEqChain: '',
  manualEqApply: false,
  // Custom output directory ('' = default sibling Audio_Pro/ next to source).
  customOutputDir: '',
  // Delivery target (docs/PLAN.md §2.3).
  platformPreset: DEFAULT_PRESET,
  // Dynamics / tone extras (docs/PLAN.md §2.6).
  denoiseMode: 'auto',
  compressionMode: 'auto',
  bodyPct: 0,
  trimSilence: true,
  normalizeMode: 'both',
  // Intensity (0-100%) for the exciter / de-esser. These supersede the
  // airExtraEnabled / deEsserEnabled flags, which are kept so settings files
  // written before the sliders keep working. 0 = stage skipped.
  airExtraEnabled: false,
  airExtraAmount: 0,
  deEsserAmount: 0,
  // Adaptive tilt correction (src/pipeline.js TONE_TILT_REFERENCE_DB).
  // Store-only: no Settings control, but a course whose teacher needs a
  // different balance can be retargeted without a rebuild.
  adaptiveToneEnabled: true,
  toneTiltTarget: 14,
  // Skip a file whose output already matches what this render would produce
  // (src/render-manifest.js). Re-running a course to fix two classes should
  // not re-render the rest.
  skipUnchanged: true,
  // How many files render at once (src/pipeline.js processQueue). Store-only;
  // 0 means "decide from the core count".
  concurrency: 0,
  // Mode 2 fusion — original + Adobe Podcast Enhance 100% (docs/PLAN.md §2.4).
  fusionEnabled: true,
  fusionMode: 'bands',
  fusionCrossoverHz: 200,
  fusionOriginalPct: 20,
  // Embedded Adobe Enhance (docs/PLAN.md §3.1 Nivel 2 / Fase 10).
  enhanceEnabled: false,
  enhanceMixPct: 100,
};

// Anything not listed here is rejected outright, so a new setting has to be
// declared deliberately rather than arriving from the renderer by accident.
const VALID_KEYS = new Set(Object.keys(DEFAULTS));

const BOOL_KEYS = new Set([
  'deEsserEnabled', 'showNotifications', 'manualEqApply', 'airExtraEnabled',
  'trimSilence', 'fusionEnabled', 'enhanceEnabled', 'adaptiveToneEnabled',
  'skipUnchanged',
]);
const STRING_KEYS = new Set(['outputFormat', 'manualEqChain', 'customOutputDir']);
const INT_KEYS = new Set([
  'hpfFrequency', 'sampleRate', 'bodyPct', 'airExtraAmount', 'deEsserAmount',
  'toneTiltTarget', 'concurrency', 'fusionCrossoverHz', 'fusionOriginalPct',
  'enhanceMixPct',
]);

const ENUM_VALUES = {
  platformPreset: Object.keys(DELIVERY_PRESETS),
  denoiseMode: ['auto', 'off'],
  compressionMode: ['auto', 'off'],
  normalizeMode: ['both', 'raiseOnly'],
  fusionMode: ['bands', 'bed', 'bands_bed'],
};

const RANGE_VALUES = {
  bodyPct: [0, 100],
  airExtraAmount: [0, 100],
  deEsserAmount: [0, 100],
  toneTiltTarget: [6, 22],
  concurrency: [0, 4],
  fusionCrossoverHz: [80, 500],
  fusionOriginalPct: [0, 40],
  enhanceMixPct: [0, 100],
};

const MAX_EQ_CHAIN_LENGTH = 4096;
const MAX_PATH_LENGTH = 1024;
// The manual EQ chain is concatenated into an FFmpeg filter graph. FFmpeg is
// spawned without a shell, so these are not shell metacharacters in the usual
// sense, but they are what breaks a filter graph out of its own expression —
// and a newline would let a second graph be smuggled in.
const EQ_CHAIN_FORBIDDEN = /[`$;&|<>\\\n\r]/;

// True when `value` may be stored under `key`. Rejection is silent by design:
// the renderer has no business sending anything else, so there is nothing
// useful to tell it.
function validate(key, value) {
  if (typeof key !== 'string' || !VALID_KEYS.has(key)) return false;
  if (BOOL_KEYS.has(key) && typeof value !== 'boolean') return false;
  if (STRING_KEYS.has(key) && typeof value !== 'string') return false;
  if (INT_KEYS.has(key) && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (ENUM_VALUES[key] && !ENUM_VALUES[key].includes(value)) return false;
  if (RANGE_VALUES[key]) {
    const [lo, hi] = RANGE_VALUES[key];
    if (value < lo || value > hi) return false;
  }
  if (key === 'manualEqChain') {
    if (value.length > MAX_EQ_CHAIN_LENGTH) return false;
    if (EQ_CHAIN_FORBIDDEN.test(value)) return false;
  }
  if (key === 'customOutputDir' && value !== '') {
    if (!path.isAbsolute(value) || value.includes('..') || value.length > MAX_PATH_LENGTH) return false;
  }
  return true;
}

// The subset the pipeline reads, pulled in one place so a new setting can't be
// added to the store and silently never reach a render.
function pipelineSettings(store) {
  const get = (k) => store.get(k);
  return {
    hpfFrequency: get('hpfFrequency'),
    deEsserEnabled: get('deEsserEnabled'),
    outputFormat: get('outputFormat'),
    sampleRate: get('sampleRate'),
    manualEqChain: get('manualEqChain'),
    manualEqApply: get('manualEqApply'),
    customOutputDir: get('customOutputDir'),
    platformPreset: get('platformPreset'),
    denoiseMode: get('denoiseMode'),
    compressionMode: get('compressionMode'),
    bodyPct: get('bodyPct'),
    airExtraEnabled: get('airExtraEnabled'),
    airExtraAmount: get('airExtraAmount'),
    deEsserAmount: get('deEsserAmount'),
    adaptiveToneEnabled: get('adaptiveToneEnabled'),
    toneTiltTarget: get('toneTiltTarget'),
    // 0 means "decide from the core count", which processQueue expresses as
    // an absent setting rather than a zero worker pool.
    concurrency: get('concurrency') || undefined,
    trimSilence: get('trimSilence'),
    skipUnchanged: get('skipUnchanged'),
    normalizeMode: get('normalizeMode'),
    fusionEnabled: get('fusionEnabled'),
    fusionMode: get('fusionMode'),
    fusionCrossoverHz: get('fusionCrossoverHz'),
    fusionOriginalPct: get('fusionOriginalPct'),
  };
}

module.exports = {
  DEFAULTS,
  VALID_KEYS,
  ENUM_VALUES,
  RANGE_VALUES,
  MAX_EQ_CHAIN_LENGTH,
  MAX_PATH_LENGTH,
  validate,
  pipelineSettings,
};
