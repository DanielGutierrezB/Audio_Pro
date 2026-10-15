'use strict';

// The download path is pinned by hash, so the test that matters is that a
// mismatch *refuses* rather than installs. Nothing here touches the network:
// fetch is stubbed, because the point is the verification around the download,
// not the download.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ffmpegSetup = require('../plugin/js/ffmpeg-setup');
const binPaths = require('../plugin/core/bin-paths');

test('the pinned macOS arm64 build matches the one the installer packs', () => {
  const build = ffmpegSetup.BUILDS['darwin-arm64'];
  assert.ok(build, 'v0.1.0 ships for Apple Silicon');

  // Same artefacts and the same hashes as scripts/fetch-bin.sh, which is what
  // goes into the .pkg. If these ever diverge, a machine that downloaded and a
  // machine that was installed from the pkg would be running different filter
  // sets — and the audio would differ for reasons nobody would think to check.
  const fetchBin = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fetch-bin.sh'), 'utf8');
  for (const [name, spec] of Object.entries(build.files)) {
    assert.ok(fetchBin.includes(spec.sha256), `${name}'s hash is not the one fetch-bin.sh pins`);
    assert.match(spec.url, /^https:/, 'pinned downloads go over TLS');
    assert.doesNotMatch(spec.url, /latest/, 'a moving URL is not a pin');
  }
});

test('platforms without a pinned build say so instead of guessing', () => {
  // Windows and Intel Macs land here until v0.2.0. The message has to point at
  // the installer, because "no ffmpeg" is otherwise indistinguishable from a
  // broken install.
  assert.equal(ffmpegSetup.BUILDS['win32-x64'], undefined);
  assert.equal(ffmpegSetup.BUILDS['darwin-x64'], undefined);
  assert.match(ffmpegSetup.platformKey(), /^[a-z0-9]+-[a-z0-9]+$/);
});

test('a hash mismatch refuses to install', async () => {
  const realFetch = global.fetch;
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-dl-'));
  process.env.HOME = home;
  // Not the pinned bytes.
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode('definitely not ffmpeg').buffer,
  });
  try {
    await assert.rejects(
      () => ffmpegSetup.install(() => {}),
      /no coincide con el hash esperado|no hay un build/,
    );
    // And nothing was written: a half-installed binary is worse than none,
    // because bin-paths would find it and the chain would fail later.
    const dir = binPaths.userSupportDir();
    if (fs.existsSync(dir)) {
      assert.deepEqual(fs.readdirSync(dir), [], 'nothing should have landed');
    }
  } finally {
    global.fetch = realFetch;
    process.env.HOME = previousHome;
  }
});

test('sha256 is computed over the archive, not the extracted file', () => {
  const buf = Buffer.from('hello');
  assert.equal(
    ffmpegSetup.sha256(buf),
    crypto.createHash('sha256').update(buf).digest('hex'),
  );
});

test('describe() names the binary a render will actually use', () => {
  const info = ffmpegSetup.describe();
  // This string ends up in the panel's log and in every master's sidecar JSON,
  // which is the only way to answer "which ffmpeg produced this file?" after
  // the fact.
  assert.ok(info.dir, 'npm run setup:bin should have put one in plugin/bin');
  assert.ok(info.ok, info.reason);
  assert.match(info.version, /^ffmpeg version/);
  assert.ok(info.major >= binPaths.MIN_FFMPEG_MAJOR);
});

test('findEntry digs the binary out of whatever shape the archive has', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-zip-'));
  const nested = path.join(dir, 'ffmpeg-8.1', 'bin');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'ffmpeg'), 'x');

  assert.equal(ffmpegSetup.findEntry(dir, 'ffmpeg'), path.join(nested, 'ffmpeg'));
  assert.equal(ffmpegSetup.findEntry(dir, 'ffprobe'), null);
});
