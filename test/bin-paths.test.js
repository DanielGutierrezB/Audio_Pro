'use strict';

// bin-paths decides which ffmpeg runs the chain, and getting that wrong is not
// a crash — it is a de-esser that silently does nothing (or attenuates
// everything, which is the bug audio_education shipped for months). So the
// interesting cases here are all about *refusing* a binary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const binPaths = require('../plugin/core/bin-paths');

// A stand-in that answers -version and -filters however the test wants, so the
// version gate and the filter gate can be checked without finding real old
// builds of ffmpeg to install.
function fakeBinDir({ version, filters }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-fakebin-'));
  const filterLines = filters.map(f => ` TS ${f} A->A       Whatever it does.`).join('\\n');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const script = `#!/bin/sh
case "$*" in
  *-filters*) printf '${filterLines}\\n' ;;
  *) echo "ffmpeg version ${version} Copyright (c) 2000-2026 the FFmpeg developers" ;;
esac
`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, script);
    fs.chmodSync(full, 0o755);
  }
  return dir;
}

test('the real bundled binaries pass every check', () => {
  // `npm run setup:bin` puts them in plugin/bin, which is also where an
  // installed extension would find its own copy.
  const dir = binPaths.extensionBinDir();
  if (!fs.existsSync(path.join(dir, 'ffmpeg'))) {
    assert.fail('plugin/bin/ffmpeg is missing — run: npm run setup:bin');
  }
  const res = binPaths.verify(dir);
  assert.ok(res.ok, res.reason);
  assert.ok(res.major >= binPaths.MIN_FFMPEG_MAJOR, `major was ${res.major}`);
});

test('an ffmpeg older than 7 is rejected: it cannot run the de-esser', () => {
  // 6.1 is not hypothetical — it is what ffmpeg-static's build gives, what the
  // panel this replaces still has in its own bin/, and the version whose
  // adynamicequalizer rejects `auto=4` outright.
  const dir = fakeBinDir({ version: '6.1', filters: binPaths.REQUIRED_FILTERS });
  const res = binPaths.verify(dir);
  assert.equal(res.ok, false);
  assert.equal(res.major, 6);
  assert.match(res.reason, /too old/);
});

test('a new enough ffmpeg missing a required filter is still rejected', () => {
  const dir = fakeBinDir({
    version: '8.1',
    filters: binPaths.REQUIRED_FILTERS.filter(f => f !== 'adynamicequalizer'),
  });
  const res = binPaths.verify(dir);
  assert.equal(res.ok, false);
  assert.match(res.reason, /adynamicequalizer/);
});

test('a directory with ffmpeg but no ffprobe is rejected', () => {
  const dir = fakeBinDir({ version: '8.1', filters: binPaths.REQUIRED_FILTERS });
  fs.unlinkSync(path.join(dir, 'ffprobe'));
  const res = binPaths.verify(dir);
  assert.equal(res.ok, false);
  assert.match(res.reason, /missing/);
  // Worth stating: the chain probes every input with ffprobe before it renders
  // anything, so half an install is no install.
});

test('the search order puts the override first and the extension before the shared dir', () => {
  const dirs = binPaths.candidateDirs();
  assert.ok(dirs.includes(binPaths.SYSTEM_SUPPORT_DIR), 'the pkg location must be searched');
  assert.ok(dirs.includes(binPaths.USER_SUPPORT_DIR), 'the download fallback must be searched');
  assert.ok(
    dirs.indexOf(binPaths.extensionBinDir()) < dirs.indexOf(binPaths.SYSTEM_SUPPORT_DIR),
    'a dev checkout wins over whatever the installer left on the machine',
  );
});

test('AUDIO_PRO_BIN_DIR wins, so a render can be pinned to a specific build', () => {
  const dir = fakeBinDir({ version: '8.1', filters: binPaths.REQUIRED_FILTERS });
  const previous = process.env.AUDIO_PRO_BIN_DIR;
  process.env.AUDIO_PRO_BIN_DIR = dir;
  try {
    assert.equal(binPaths.getBinDir(), dir);
    assert.equal(binPaths.ffmpeg(), path.join(dir, 'ffmpeg'));
  } finally {
    if (previous === undefined) delete process.env.AUDIO_PRO_BIN_DIR;
    else process.env.AUDIO_PRO_BIN_DIR = previous;
  }
});

test('the RNNoise model is absent on purpose, and that is not an error', () => {
  // Mode 1's local denoise is unreachable from this panel: every sequence is
  // paired with an Adobe pass. pipeline.js reads null as "unavailable" and
  // renders without it.
  assert.equal(binPaths.rnnoiseModel(), null);
});
