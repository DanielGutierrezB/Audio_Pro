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

test('an update swaps the whole extension at once, and keeps a local bin/', () => {
  const previous = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-swap-'));
  process.env.HOME = home;
  try {
    const ext = path.join(home, 'ext');
    fs.mkdirSync(path.join(ext, 'js'), { recursive: true });
    fs.mkdirSync(path.join(ext, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'js', 'removed-in-new-version.js'), 'old');
    fs.writeFileSync(path.join(ext, 'bin', 'ffmpeg'), 'binary');

    const staged = path.join(home, 'staged');
    fs.mkdirSync(path.join(staged, 'js'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'js', 'main.js'), 'new');

    updater.swapInto(staged, ext);

    assert.ok(fs.existsSync(path.join(ext, 'js', 'main.js')));
    // An in-place unzip would have left this behind; the panel loads whatever
    // is on disk, so a stale file is a bug that reproduces on one machine.
    assert.equal(fs.existsSync(path.join(ext, 'js', 'removed-in-new-version.js')), false);
    // The ZXP never carries binaries, so one living in the extension survives.
    assert.equal(fs.readFileSync(path.join(ext, 'bin', 'ffmpeg'), 'utf8'), 'binary');
    // Nothing is left beside the extension for CEP to register as a second panel.
    assert.deepEqual(fs.readdirSync(home).filter(n => n !== '.audio-pro'), ['ext']);
    assert.equal(fs.existsSync(path.join(home, '.audio-pro', 'update-prev')), false);
  } finally {
    process.env.HOME = previous;
  }
});

test('a dev install (a symlink into a git checkout) is recognised and never self-updated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-dev-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'plugin', 'js'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plugin', 'js', 'main.js'), 'my uncommitted work');
  const link = path.join(root, 'com.danielgutierrez.audiopro');
  fs.symlinkSync(path.join(repo, 'plugin'), link);

  assert.equal(updater.isDevCheckout(link), true);
  // Installing a release here would swap the checkout's plugin/ out and delete
  // it as the "old" tree. It must refuse before downloading anything.
  await assert.rejects(() => updater.install('http://127.0.0.1:1/never.zxp', link), /desarrollo/);
  assert.equal(fs.readFileSync(path.join(repo, 'plugin', 'js', 'main.js'), 'utf8'), 'my uncommitted work');

  const installed = path.join(root, 'installed');
  fs.mkdirSync(installed);
  assert.equal(updater.isDevCheckout(installed), false, 'an installed copy updates normally');
});

test('the updater points at this repo', () => {
  // A copy-paste of the old panel's repo here would quietly install the wrong
  // extension over this one.
  assert.equal(updater.UPDATE_REPO, 'DanielGutierrezB/Audio_Pro');
});
