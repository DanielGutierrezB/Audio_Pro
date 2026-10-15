'use strict';

// ── Self-update from GitHub Releases ────────────────────────────────────
// Same mechanism as the Adobe Podcast Enhance panel, pointed at this repo:
// read the latest release, download its .zxp (a zip), unzip it over the
// extension directory, reload the panel.
//
// Two things are deliberate:
//
//   - The .zxp carries no binaries. ffmpeg lives in the shared support dir
//     the installer wrote, so an update never has to re-download 100 MB and
//     never disturbs a working binary. (It also means a release that changes
//     the binaries needs a new .pkg, which is why build-pkg.sh exists in the
//     same workflow.)
//   - The log is written to disk as well as to the panel. The last thing an
//     update does is reload the panel, which wipes the in-memory log — i.e.
//     exactly the information you need when an update fails is the
//     information that disappears.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UPDATE_REPO = 'DanielGutierrezB/Audio_Pro';

function supportDir() { return path.join(os.homedir(), '.audio-pro'); }
function updateLogFile() { return path.join(supportDir(), 'update.log'); }

function appendLog(msg) {
  try {
    fs.mkdirSync(supportDir(), { recursive: true });
    fs.appendFileSync(updateLogFile(), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* the log is a convenience, never a reason to fail an update */ }
}

function readLog() {
  try { return fs.readFileSync(updateLogFile(), 'utf8').replace(/\s+$/, ''); } catch { return ''; }
}

function resetLog() {
  try { fs.unlinkSync(updateLogFile()); } catch { /* already gone */ }
}

// Numeric, segment by segment: '0.10.0' is newer than '0.9.0', which a string
// comparison gets wrong.
function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// Looks for a newer release. Returns { available, tag, assetUrl } — never
// throws: a failed check is not worth an error toast, the panel works fine
// without updating.
async function check(currentVersion) {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    const tag = json.tag_name || '';
    const asset = (json.assets || []).find(a => /\.zxp$/i.test(a.name || ''));
    return {
      available: !!asset && isNewer(tag, currentVersion),
      tag,
      assetUrl: asset ? asset.browser_download_url : null,
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

// Several methods, because one missing tool should not block an update:
// ditto and unzip on macOS, tar and PowerShell on Windows.
function unzipInto(zipPath, dir) {
  return new Promise((resolve, reject) => {
    const attempts = process.platform === 'win32'
      ? [
        ['tar', ['-xf', zipPath, '-C', dir]],
        ['powershell', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(dir)} -Force`]],
      ]
      : [
        ['/usr/bin/ditto', ['-x', '-k', zipPath, dir]],
        ['/usr/bin/unzip', ['-o', '-q', zipPath, '-d', dir]],
      ];

    let i = 0;
    const tryNext = (prevErr) => {
      if (i >= attempts.length) return reject(prevErr || new Error('no pude descomprimir'));
      const [cmd, args] = attempts[i++];
      execFile(cmd, args, { maxBuffer: 1 << 27 }, (err, _so, se) => {
        if (err) {
          appendLog(`descompresión con ${cmd} falló: ${String(se || err.message).slice(0, 200)}`);
          tryNext(new Error(String(se || err.message)));
        } else {
          resolve();
        }
      });
    };
    tryNext(null);
  });
}

// Staging lives under ~/.audio-pro, not next to the extension: CEP registers
// every directory in its extensions folder that has a manifest, so a leftover
// copy there (from a crash mid-update) would show up as a second panel with
// the same id. The home directory is on the same volume as ~/Library, which
// is what keeps the renames below atomic.
function stagingDir(name) { return path.join(supportDir(), name); }

// Replaces `extDir` with the contents of `stagedDir` without ever leaving a
// half-written extension behind. Two renames on the same volume, each atomic:
// the old tree moves aside, the new one moves in, and only then is the old one
// deleted. If the second rename fails the first is undone. A bin/ the user
// (or a dev checkout) put inside the extension is carried over, because the
// ZXP never contains one.
function swapInto(stagedDir, extDir) {
  const prev = stagingDir('update-prev');
  fs.mkdirSync(path.dirname(prev), { recursive: true });
  fs.rmSync(prev, { recursive: true, force: true });
  const oldBin = path.join(extDir, 'bin');
  if (fs.existsSync(oldBin) && !fs.existsSync(path.join(stagedDir, 'bin'))) {
    fs.cpSync(oldBin, path.join(stagedDir, 'bin'), { recursive: true });
  }
  fs.renameSync(extDir, prev);
  try {
    fs.renameSync(stagedDir, extDir);
  } catch (err) {
    fs.renameSync(prev, extDir);
    throw err;
  }
  fs.rmSync(prev, { recursive: true, force: true });
}

// True when `extDir` is a git working tree rather than an installed copy —
// i.e. the dev install (scripts/dev-install.sh), where the CEP extension is a
// symlink to plugin/ in the repo. Installing a release there would replace
// the checkout's plugin/ with the ZXP's contents and delete it as the "old"
// tree, so the panel never self-updates in that case.
function isDevCheckout(extDir) {
  try {
    return fs.existsSync(path.join(fs.realpathSync(extDir), '..', '.git'));
  } catch {
    return false;
  }
}

// Downloads `assetUrl` and installs it in place of `extDir`. The ZXP is
// unzipped into a sibling directory and checked there first — a full tree with
// a readable manifest of the version we expected — so a failed or truncated
// extraction never touches the running extension, and files a new version
// removed do not linger (the same reason pkg/scripts/postinstall uses
// rsync --delete). Resolves to the installed version.
async function install(assetUrl, extDir, onStatus = () => {}) {
  if (isDevCheckout(extDir)) {
    throw new Error('esta es la instalación de desarrollo (un checkout de git); actualizala con git pull');
  }
  resetLog();
  appendLog('descargando ' + assetUrl);
  onStatus('Descargando actualización…');

  const res = await fetch(assetUrl);
  appendLog(`HTTP ${res.status} ${res.ok ? 'ok' : 'ERROR'}`);
  if (!res.ok) throw new Error(`descarga HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // A zip starts with "PK". Anything else means we downloaded an error page,
  // and unzipping that would leave the extension half-written.
  if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`lo descargado no es un ZXP válido (${buf.length} bytes)`);
  }

  const tmpZxp = path.join(os.tmpdir(), `audiopro_update_${Date.now()}.zxp`);
  fs.writeFileSync(tmpZxp, buf);
  const staged = stagingDir('update-next');
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  appendLog(`${buf.length} bytes → descomprimiendo en ${staged}`);
  onStatus('Instalando…');
  try {
    await unzipInto(tmpZxp, staged);
    const version = manifestVersion(staged);
    if (version === '?' || !fs.existsSync(path.join(staged, 'index.html'))) {
      throw new Error('el ZXP descomprimido no tiene un panel completo');
    }
    swapInto(staged, extDir);
    appendLog(`OK, instalada la v${version}`);
    return version;
  } finally {
    try { fs.unlinkSync(tmpZxp); } catch { /* best effort */ }
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

function manifestVersion(extDir) {
  try {
    const xml = fs.readFileSync(path.join(extDir, 'CSXS', 'manifest.xml'), 'utf8');
    return (xml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1] || '?';
  } catch {
    return '?';
  }
}

module.exports = {
  check,
  install,
  isNewer,
  parseVersion,
  manifestVersion,
  isDevCheckout,
  swapInto,
  unzipInto,
  appendLog,
  readLog,
  resetLog,
  updateLogFile,
  UPDATE_REPO,
};
