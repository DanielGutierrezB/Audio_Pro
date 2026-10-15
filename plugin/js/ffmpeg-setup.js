'use strict';

// ── Making sure the panel has an ffmpeg that can run the chain ──────────
//
// Normally there is nothing to do: the .pkg installs ffmpeg/ffprobe 8.1 into
// /Library/Application Support/AudioPro/bin and plugin/core/bin-paths.js finds
// them there. This module exists for the two cases where it does not:
//
//   1. The extension was installed by hand (git clone + symlink, or an
//      unzipped ZXP) and never saw the installer.
//   2. Something on the machine has an older ffmpeg that bin-paths would
//      otherwise fall back to. The panel this one replaces ships a 6.0 in its
//      own bin/, and 6.1 and below reject `adynamicequalizer`'s `auto=4`
//      outright — the de-esser becomes an error or a silent no-op. That bug
//      stayed green in CI upstream for months precisely because the tested
//      binary was not the shipped one
//      (audio_education/docs/PREMIERE-INTEGRATION.md §12).
//
// So: report exactly which binary is in play (describe), and when there is
// none, download the same SHA256-pinned build the installer uses into
// ~/.audio-pro/bin. Never the "latest" of anything — a moving URL is how you
// end up with a different filter set than the one the chain was measured
// against.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');

const binPaths = require('../core/bin-paths');

// Pinned, per platform. Same artefacts and hashes as scripts/fetch-bin.sh,
// which is what the installer packs — a machine that downloads and a machine
// that was installed from the pkg end up with the same bytes.
//
// macOS arm64 is the only entry for v0.1.0. Windows x64 and macOS Intel need
// a build of ffmpeg 8 pinned to a specific tag plus its hash; the table is
// here so adding them is data, not code.
const BUILDS = {
  'darwin-arm64': {
    label: 'macOS Apple Silicon',
    files: {
      ffmpeg: {
        url: 'https://www.osxexperts.net/ffmpeg81arm.zip',
        sha256: 'ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad',
        entry: 'ffmpeg',
      },
      ffprobe: {
        url: 'https://www.osxexperts.net/ffprobe81arm.zip',
        sha256: 'a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1',
        entry: 'ffprobe',
      },
    },
  },
  // 'win32-x64':   pending — a pinned BtbN release (never `latest`) + hashes
  // 'darwin-x64':  pending — an evermeet static x86_64 build + hashes
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

// What the panel logs on startup. The point is that the log answers "which
// ffmpeg did this render actually use?" without anyone having to guess, and
// the sidecar JSON next to each master records the same string.
//
// A verdict of "usable" is cached for the session: verifying costs three
// synchronous ffmpeg processes on the panel's UI thread, and it runs before
// every Procesar. A negative verdict is not cached, so installing a binary
// takes effect without reloading the panel.
let usable = null;

function describe() {
  if (usable && binPaths.getBinDir() === usable.dir) return usable;
  const dir = binPaths.getBinDir();
  if (!dir) return { ok: false, dir: null, version: null, reason: 'no ffmpeg found' };
  const check = binPaths.verify(dir);
  const info = {
    ok: check.ok,
    dir,
    major: check.major ?? null,
    version: binPaths.versionLine(dir),
    reason: check.ok ? null : check.reason,
  };
  usable = info.ok ? info : null;
  return info;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`descarga de ${path.basename(url)}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Extraction without a zip library: macOS has ditto, and Windows (v0.2.0, see
// BUILDS) has tar.
function extract(archivePath, entry, destPath) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-unzip-'));
    const [cmd, args] = process.platform === 'win32'
      ? ['tar', ['-xf', archivePath, '-C', dir]]
      : ['/usr/bin/ditto', ['-x', '-k', archivePath, dir]];
    execFile(cmd, args, { maxBuffer: 1 << 27 }, (err) => {
      if (err) return reject(new Error(`no pude descomprimir: ${err.message}`));
      const found = findEntry(dir, entry);
      if (!found) return reject(new Error(`el archivo no contenía "${entry}"`));
      try {
        fs.copyFileSync(found, destPath);
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      } catch (copyErr) { reject(copyErr); }
    });
  });
}

function findEntry(dir, entry, depth = 0) {
  if (depth > 4) return null;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const hit = findEntry(full, entry, depth + 1);
      if (hit) return hit;
    } else if (name === entry || name === entry + '.exe') {
      return full;
    }
  }
  return null;
}

// Downloads the pinned build into ~/.audio-pro/bin and verifies it can run the
// chain before declaring success. onStatus(message) feeds the panel's toast,
// because this is a ~100 MB download and silence looks like a hang.
async function install(onStatus = () => {}) {
  const key = platformKey();
  const build = BUILDS[key];
  if (!build) {
    throw new Error(
      `no hay un build de ffmpeg pineado para ${key}. ` +
      'Instalá Audio Pro con el .pkg, que ya los trae.',
    );
  }

  const dest = binPaths.userSupportDir();
  fs.mkdirSync(dest, { recursive: true });

  for (const [name, spec] of Object.entries(build.files)) {
    const target = path.join(dest, name + (process.platform === 'win32' ? '.exe' : ''));
    onStatus(`Descargando ${name} (${build.label})…`);
    const buf = await download(spec.url);

    const actual = sha256(buf);
    if (actual !== spec.sha256) {
      // Refuse rather than install: a different binary means a different
      // filter set, and the failure would surface later as mangled audio.
      throw new Error(
        `el ${name} descargado no coincide con el hash esperado ` +
        `(${actual.slice(0, 12)}… != ${spec.sha256.slice(0, 12)}…). No lo instalo.`,
      );
    }

    const tmpArchive = path.join(os.tmpdir(), `audiopro-${name}-${Date.now()}`);
    fs.writeFileSync(tmpArchive, buf);
    try {
      await extract(tmpArchive, spec.entry, target);
    } finally {
      try { fs.unlinkSync(tmpArchive); } catch { /* best effort */ }
    }
    fs.chmodSync(target, 0o755);
    // Anything downloaded carries the quarantine flag, and Gatekeeper kills a
    // quarantined binary the first time it is spawned.
    if (process.platform === 'darwin') {
      await new Promise(res => execFile('xattr', ['-d', 'com.apple.quarantine', target], () => res()));
    }
    onStatus(`${name} listo (${Math.round(buf.length / 1e6)} MB, sha256 verificado).`);
  }

  const check = binPaths.verify(dest);
  if (!check.ok) {
    throw new Error(`el ffmpeg descargado no sirve para esta cadena: ${check.reason}`);
  }
  return { dir: dest, major: check.major };
}

// What the panel calls before spending credits: downloads only when there is
// nothing usable, and throws unless the binary bin-paths will actually pick
// afterwards can run the chain. The download lands in ~/.audio-pro/bin, which
// is not first in the search order, so a broken binary higher up would still
// win — saying "ready" in that case would spend Adobe credits on a sequence
// that then cannot be mastered.
async function ensure(onStatus = () => {}) {
  const current = describe();
  if (current.ok) return { ...current, installed: false };

  onStatus('No encontré un ffmpeg que sirva — lo descargo una sola vez…');
  await install(onStatus);
  const after = describe();
  if (!after.ok) {
    throw new Error(`instalé ffmpeg, pero el que se usaría (${after.dir}) no sirve: ${after.reason}`);
  }
  return { ...after, installed: true };
}

module.exports = {
  ensure,
  install,
  describe,
  platformKey,
  BUILDS,
  // exported for tests
  findEntry,
  sha256,
};
