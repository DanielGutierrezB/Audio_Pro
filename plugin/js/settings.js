'use strict';

// ── The panel's settings, on disk ───────────────────────────────────────
// Stored at ~/.audio-pro/settings.json rather than in localStorage: the panel
// reloads itself after an update, and CEP's storage has been known not to
// survive that. A plain JSON file also means a setting can be fixed by hand
// when something goes wrong in the field.
//
// Every value that reaches the pipeline goes through core/settings.validate
// before it is stored *and* again before it is sent. That is not belt and
// braces: validate is the real trust boundary (manualEqChain is spliced into
// an ffmpeg filter graph, customOutputDir becomes a write target), and a
// settings file edited by hand is exactly the untrusted input it exists for.
//
// Three keys are the panel's own and are not pipeline settings, so they are
// validated here: the two colour labels and muteOthers.

const fs = require('fs');
const os = require('os');
const path = require('path');

const coreSettings = require('../core/settings');

// Mango and Green. Premiere numbers colour labels 0-15.
const DEFAULT_LABEL_IN_PROGRESS = 7;
const DEFAULT_LABEL_DONE = 13;

const PANEL_DEFAULTS = {
  muteOthers: true,
  labelInProgress: DEFAULT_LABEL_IN_PROGRESS,
  labelDone: DEFAULT_LABEL_DONE,
};

// Pipeline settings the panel lets you change. Everything else keeps the
// core's default. Deliberately absent, with reasons:
//
//   trimSilence      — must stay false. atrim shifts the audio earlier and
//                      desyncs the timeline, which is the single easiest
//                      mistake to make here and the hardest to notice.
//   skipUnchanged    — must stay false. Each run exports to a fresh path, so
//                      the render manifest has nothing useful to say, and a
//                      "skipped" file would leave the clip stuck in Mango.
//   normalizeMode    — set per run: raiseOnly for an In→Out region, because
//                      normalising a 20-second excerpt to -16 LUFS normalises
//                      *that excerpt*, not the sequence it came from.
//   customOutputDir  — set per run to the project's Audio_Process/Audio_Pro.
const EXPOSED = [
  'platformPreset',
  'fusionMode',
  'fusionOriginalPct',
  'toneTiltTarget',
  'deEsserAmount',
  'airExtraAmount',
  'bodyPct',
];

function settingsFile() { return path.join(os.homedir(), '.audio-pro', 'settings.json'); }

function defaults() {
  const out = { ...PANEL_DEFAULTS };
  for (const key of EXPOSED) out[key] = coreSettings.DEFAULTS[key];
  return out;
}

function validatePanelKey(key, value) {
  if (key === 'muteOthers') return typeof value === 'boolean';
  if (key === 'labelInProgress' || key === 'labelDone') {
    return Number.isInteger(value) && value >= 0 && value <= 15;
  }
  return false;
}

// True when `value` may be stored under `key`. Rejection is silent, like the
// core's: the UI has no business sending anything else.
function accepts(key, value) {
  if (key in PANEL_DEFAULTS) return validatePanelKey(key, value);
  if (EXPOSED.includes(key)) return coreSettings.validate(key, value);
  return false;
}

function load() {
  const merged = defaults();
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch { return merged; }
  if (!stored || typeof stored !== 'object') return merged;
  for (const [key, value] of Object.entries(stored)) {
    if (accepts(key, value)) merged[key] = value;
  }
  return merged;
}

function save(values) {
  const clean = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (accepts(key, value)) clean[key] = value;
  }
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(clean, null, 2));
    return { ok: true, saved: clean };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The object handed to core/pipeline.processQueue. The three fixed values are
// the ones the Premiere path cannot work without (see EXPOSED above).
//
// concurrency is 1 because the pool is one level up: the panel runs one
// mastering job at a time while the next sequence is still uploading to
// Adobe, and the editor is using this machine too. Two files each spawning
// their own ffmpeg stages would trade wall-clock for contention.
function pipelineSettings(values, { outputDir, inOut = false } = {}) {
  const v = values || load();
  const out = {
    trimSilence: false,
    skipUnchanged: false,
    fusionEnabled: true,
    concurrency: 1,
    normalizeMode: inOut ? 'raiseOnly' : 'both',
  };
  for (const key of EXPOSED) {
    if (v[key] !== undefined) out[key] = v[key];
  }
  if (outputDir) out.customOutputDir = outputDir;
  return out;
}

module.exports = {
  load,
  save,
  defaults,
  accepts,
  pipelineSettings,
  settingsFile,
  EXPOSED,
  PANEL_DEFAULTS,
};
