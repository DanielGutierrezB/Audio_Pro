'use strict';

// Skipping is the one feature here that can silently deliver a stale file, so
// the tests are mostly about what must NOT be skipped. A false skip means an
// editor fixes a take, re-runs, and ships the old master believing it is new.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const manifest = require('../../plugin/core/render-manifest');

let dir;
let source;
let output;

const SETTINGS = { outputFormat: 'wav24', platformPreset: 'platzi', deEsserAmount: 60 };

// mtime has millisecond resolution, so a rewrite within the same millisecond
// can keep the same signature. Nudging it is what a real edit would do.
function touch(file, contents) {
  fs.writeFileSync(file, contents);
  const t = Date.now() / 1000 + 10;
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-manifest-'));
  source = path.join(dir, 'clase.wav');
  output = path.join(dir, 'clase-out.wav');
  fs.writeFileSync(source, 'original take');
  fs.writeFileSync(output, 'rendered master');
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('an unrecorded output is never up to date', () => {
  const fp = manifest.fingerprint({ path: source }, SETTINGS);
  assert.equal(manifest.isUpToDate(output, fp), false, 'no manifest means nothing is known');
});

test('a recorded, untouched render is up to date', () => {
  const fp = manifest.fingerprint({ path: source }, SETTINGS);
  manifest.record(output, fp);
  assert.equal(manifest.isUpToDate(output, fp), true);
});

test('a re-recorded source invalidates the render', () => {
  manifest.record(output, manifest.fingerprint({ path: source }, SETTINGS));
  touch(source, 'a different, longer take');
  const fp = manifest.fingerprint({ path: source }, SETTINGS);
  assert.equal(manifest.isUpToDate(output, fp), false,
    'the master no longer corresponds to the take it was made from');
});

test('a deleted output invalidates the render', () => {
  const fp = manifest.fingerprint({ path: source }, SETTINGS);
  manifest.record(output, fp);
  fs.unlinkSync(output);
  assert.equal(manifest.isUpToDate(output, fp), false);
});

test('a new Enhanced/ pair invalidates the render', () => {
  const pair = path.join(dir, 'enhanced.wav');
  fs.writeFileSync(pair, 'adobe pass');
  const file = { path: source, pairPath: pair };
  manifest.record(output, manifest.fingerprint(file, SETTINGS));

  touch(pair, 'a re-run of the adobe pass');
  assert.equal(manifest.isUpToDate(output, manifest.fingerprint(file, SETTINGS)), false);
});

test('gaining or losing a pair invalidates the render', () => {
  const pair = path.join(dir, 'enhanced.wav');
  fs.writeFileSync(pair, 'adobe pass');
  manifest.record(output, manifest.fingerprint({ path: source }, SETTINGS));
  // Mode 1 before, Mode 2 now: a completely different render.
  assert.equal(
    manifest.isUpToDate(output, manifest.fingerprint({ path: source, pairPath: pair }, SETTINGS)),
    false);
});

test('every setting that reaches the render invalidates it when changed', () => {
  // The real hazard: a slider that is read by the pipeline but missing from
  // the fingerprint means someone nudges it, re-runs, and gets the old file.
  const base = {};
  for (const key of manifest.FINGERPRINTED_SETTINGS) base[key] = 1;
  const baseDigest = manifest.settingsDigest(base);

  for (const key of manifest.FINGERPRINTED_SETTINGS) {
    const changed = { ...base, [key]: 2 };
    assert.notEqual(manifest.settingsDigest(changed), baseDigest,
      `changing ${key} must invalidate the render`);
  }
});

test('a setting the render ignores does not force a re-render', () => {
  const a = manifest.settingsDigest({ ...SETTINGS, showNotifications: true });
  const b = manifest.settingsDigest({ ...SETTINGS, showNotifications: false });
  assert.equal(a, b, 'notifications have nothing to do with the audio');
});

test('an unreadable source yields no fingerprint, so the caller must render', () => {
  assert.equal(manifest.fingerprint({ path: path.join(dir, 'missing.wav') }, SETTINGS), null);
  assert.equal(manifest.isUpToDate(output, null), false);
});

test('a corrupt or foreign manifest is ignored rather than trusted', () => {
  const fp = manifest.fingerprint({ path: source }, SETTINGS);
  fs.writeFileSync(path.join(dir, manifest.MANIFEST_NAME), 'not json at all');
  assert.equal(manifest.isUpToDate(output, fp), false);

  fs.writeFileSync(path.join(dir, manifest.MANIFEST_NAME),
    JSON.stringify({ version: manifest.MANIFEST_VERSION + 1, entries: { 'clase-out.wav': fp } }));
  assert.equal(manifest.isUpToDate(output, fp), false, 'a future version must not be read as this one');
});

test('recording one output leaves the others alone', () => {
  const other = path.join(dir, 'otra-out.wav');
  fs.writeFileSync(other, 'another master');
  const fpA = manifest.fingerprint({ path: source }, SETTINGS);
  manifest.record(output, fpA);
  manifest.record(other, fpA);
  assert.equal(manifest.isUpToDate(output, fpA), true);
  assert.equal(manifest.isUpToDate(other, fpA), true);
});
