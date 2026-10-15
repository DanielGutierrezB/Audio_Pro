'use strict';

// The updater's two jobs that can be checked without a network: deciding
// whether a release is newer, and reading back the version it just installed.
// Both have a failure mode that is annoying rather than loud — a panel that
// nags about an update forever, or one that never offers one again.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const updater = require('../plugin/js/updater');

test('version comparison is numeric, not lexicographic', () => {
  assert.equal(updater.isNewer('v0.2.0', '0.1.0'), true);
  assert.equal(updater.isNewer('0.1.1', '0.1.0'), true);
  // The one a string comparison gets wrong, and the reason this is not a
  // one-liner: '0.10.0' < '0.9.0' as text.
  assert.equal(updater.isNewer('v0.10.0', 'v0.9.0'), true);
  assert.equal(updater.isNewer('v1.0.0', 'v0.99.99'), true);
});

test('the same version, or an older one, is not an update', () => {
  assert.equal(updater.isNewer('v0.1.0', '0.1.0'), false);
  assert.equal(updater.isNewer('0.1.0', 'v0.2.0'), false);
  assert.equal(updater.isNewer('v0.9.0', 'v0.10.0'), false);
});

test('the leading v is optional on either side', () => {
  assert.deepEqual(updater.parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(updater.parseVersion('1.2.3'), [1, 2, 3]);
  // A malformed tag reads as zeros rather than NaN, so it simply never counts
  // as newer instead of throwing inside the check.
  assert.deepEqual(updater.parseVersion('garbage'), [0]);
  assert.equal(updater.isNewer('garbage', '0.1.0'), false);
});

test('the installed version is read back from the manifest on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-upd-'));
  fs.mkdirSync(path.join(dir, 'CSXS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CSXS', 'manifest.xml'),
    '<ExtensionManifest ExtensionBundleId="com.danielgutierrez.audiopro" ExtensionBundleVersion="0.4.2">');

  // This is the proof that files actually changed — without it an update that
  // silently failed to unzip would still report success and reload.
  assert.equal(updater.manifestVersion(dir), '0.4.2');
  assert.equal(updater.manifestVersion(path.join(dir, 'nope')), '?');
});

test('the update log survives the reload that ends the update', () => {
  const previous = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-home-'));
  process.env.HOME = home;
  try {
    // updater reads homedir() per call, so the redirected HOME applies.
    updater.resetLog();
    updater.appendLog('descargando algo');
    updater.appendLog('FALLÓ: se cayó la red');
    const log = updater.readLog();
    assert.match(log, /descargando algo/);
    assert.match(log, /FALLÓ/);
    assert.ok(updater.updateLogFile().startsWith(home), 'the log lives under ~/.audio-pro');
  } finally {
    process.env.HOME = previous;
  }
});

test('the updater points at this repo', () => {
  // A copy-paste of the old panel's repo here would quietly install the wrong
  // extension over this one.
  assert.equal(updater.UPDATE_REPO, 'DanielGutierrezB/Audio_Pro');
});
