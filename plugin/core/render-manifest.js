'use strict';

// ── Render manifest ─────────────────────────────────────────────────────
// Re-running a course to fix two classes used to re-render all forty. This
// records what each output was made from, so an unchanged file can be skipped.
//
// The manifest is a single JSON file in the output directory, so it travels
// with the outputs: copy `Audio_Pro/` elsewhere and the record goes along,
// delete it and the next run simply re-renders everything.
//
// What counts as "unchanged" is the whole point. The fingerprint covers the
// source (path, size, mtime), the Mode 2 pair the same way, and every setting
// that reaches the render. So re-recording a take, dropping in a new Enhanced/
// pair, nudging the de-esser, or switching the delivery preset all invalidate
// it — and deleting the output does too, since the file has to still be there.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_NAME = '.audiopro-renders.json';
const MANIFEST_VERSION = 1;

// The settings the render actually depends on. Anything absent here is a
// setting whose change would NOT trigger a re-render, so the list is
// deliberately exhaustive rather than convenient — a missing key means
// someone changes a slider, re-runs, and silently gets the old file.
const FINGERPRINTED_SETTINGS = [
  'outputFormat', 'sampleRate', 'platformPreset', 'normalizeMode',
  'hpfFrequency', 'manualEqApply', 'manualEqChain',
  'adaptiveToneEnabled', 'toneTiltTarget',
  'denoiseMode', 'compressionMode', 'bodyPct',
  'deEsserEnabled', 'deEsserAmount', 'airExtraEnabled', 'airExtraAmount',
  'trimSilence',
  'fusionEnabled', 'fusionMode', 'fusionCrossoverHz', 'fusionOriginalPct',
];

function manifestPath(outputDir) {
  return path.join(outputDir, MANIFEST_NAME);
}

// Size and mtime rather than a content hash: a course is tens of files at
// tens of MB each, and re-hashing all of them to decide what to skip would
// cost more than the renders being skipped.
function statSignature(filePath) {
  try {
    const { size, mtimeMs } = fs.statSync(filePath);
    return `${size}:${Math.round(mtimeMs)}`;
  } catch {
    return null;
  }
}

function settingsDigest(settings = {}) {
  const picked = {};
  for (const key of FINGERPRINTED_SETTINGS) picked[key] = settings[key] ?? null;
  return crypto.createHash('sha1').update(JSON.stringify(picked)).digest('hex').slice(0, 16);
}

// Returns null when the source can't be read — with nothing to compare, the
// caller must render rather than skip.
function fingerprint(file, settings) {
  const source = statSignature(file.path);
  if (!source) return null;
  return {
    source,
    pair: file.pairPath ? statSignature(file.pairPath) : null,
    settings: settingsDigest(settings),
  };
}

function read(outputDir) {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath(outputDir), 'utf8'));
    if (data?.version !== MANIFEST_VERSION || typeof data.entries !== 'object') return {};
    return data.entries ?? {};
  } catch {
    return {};
  }
}

function sameFingerprint(a, b) {
  return !!a && !!b
    && a.source === b.source
    && a.pair === b.pair
    && a.settings === b.settings;
}

// True when `outputPath` already holds exactly what this render would produce.
function isUpToDate(outputPath, fp) {
  if (!fp) return false;
  if (!fs.existsSync(outputPath)) return false;
  const entries = read(path.dirname(outputPath));
  return sameFingerprint(entries[path.basename(outputPath)], fp);
}

// Best-effort: a manifest that can't be written costs a redundant render next
// time, which is not worth failing a finished render over.
function record(outputPath, fp) {
  if (!fp) return;
  const dir = path.dirname(outputPath);
  try {
    const entries = read(dir);
    entries[path.basename(outputPath)] = { ...fp, renderedAt: new Date().toISOString() };
    fs.writeFileSync(
      manifestPath(dir),
      JSON.stringify({ version: MANIFEST_VERSION, entries }, null, 2),
    );
  } catch { /* the render itself succeeded; this is only bookkeeping */ }
}

module.exports = {
  fingerprint, isUpToDate, record, settingsDigest, sameFingerprint,
  MANIFEST_NAME, MANIFEST_VERSION, FINGERPRINTED_SETTINGS,
};
