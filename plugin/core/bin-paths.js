'use strict';

// ── Where ffmpeg and ffprobe live ───────────────────────────────────────
// The one file in core/ that is NOT a copy of audio_education: upstream's
// resolves binaries inside an Electron bundle (`process.resourcesPath`),
// which does not exist in a CEP panel. Everything else in this directory is
// byte-compared against the upstream tag by scripts/check-core.sh; this one
// is excluded there on purpose.
//
// The chain is not ffmpeg-version-agnostic, which is the whole reason this
// file is picky instead of just taking the first binary it finds. ffmpeg 6.1
// rejects `adynamicequalizer`'s `auto=4` outright ("Numerical result out of
// range"), so the de-esser silently becomes an error or a no-op, and the panel
// that this one replaces ships a 6.0 in its own bin/ — a binary that is
// already on this machine and must never be picked up.
// See audio_education/docs/PREMIERE-INTEGRATION.md §12.
//
// Order, first hit wins:
//   1. AUDIO_PRO_BIN_DIR         — tests and anyone pinning a specific build
//   2. <extension>/bin           — `npm run setup:bin` in a dev checkout
//   3. /Library/Application Support/AudioPro/bin   — what the .pkg installs
//   4. ~/.audio-pro/bin          — js/ffmpeg-setup.js's download fallback
//   5. AudioPro.app's bundle     — reused read-only when it passes the checks
//
// 1-4 are ours and are trusted on sight. 5 belongs to another app that can be
// updated or downgraded behind our back, so it is verified (`-version` and the
// filter list) before being accepted, and the result is cached per process.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

const SYSTEM_SUPPORT_DIR = '/Library/Application Support/AudioPro/bin';
const USER_SUPPORT_DIR = path.join(os.homedir(), '.audio-pro', 'bin');
const AUDIOPRO_APP_DIR = '/Applications/AudioPro.app/Contents/Resources/bin';

// Minimum major version. 7 is where the de-esser's options became reliable;
// the .pkg installs 8.1.
const MIN_FFMPEG_MAJOR = 7;

// Filters the mastering chain cannot run without. `arnndn` is deliberately
// absent: it is Mode 1 only and this panel always pairs with an Adobe pass.
const REQUIRED_FILTERS = [
  'adynamicequalizer',
  'acrossover',
  'aexciter',
  'adeclick',
  'adeclip',
  'acompressor',
  'loudnorm',
  'alimiter',
  'astats',
  'ebur128',
  'axcorrelate',
];

function extensionBinDir() {
  return path.join(__dirname, '..', 'bin');
}

function candidateDirs() {
  const dirs = [];
  if (process.env.AUDIO_PRO_BIN_DIR) dirs.push(process.env.AUDIO_PRO_BIN_DIR);
  dirs.push(extensionBinDir(), SYSTEM_SUPPORT_DIR, USER_SUPPORT_DIR);
  return dirs;
}

function hasBoth(dir) {
  try {
    return fs.existsSync(path.join(dir, 'ffmpeg' + EXE))
      && fs.existsSync(path.join(dir, 'ffprobe' + EXE));
  } catch {
    return false;
  }
}

// `-version`/`-filters` on every resolve would be two extra processes per
// ffmpeg call, and the pipeline makes several per file.
let verifiedForeignDir;

function majorVersionOf(ffmpegPath) {
  try {
    const out = execFileSync(ffmpegPath, ['-version'], { encoding: 'utf8', timeout: 10000 });
    const m = out.match(/^ffmpeg version n?(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function missingFilters(ffmpegPath) {
  let out;
  try {
    out = execFileSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 20000 });
  } catch {
    return REQUIRED_FILTERS.slice();
  }
  const present = new Set();
  for (const line of out.split('\n')) {
    // " TS adynamicequalizer A->A   Apply Dynamic Equalization of input audio."
    // The flags column is what varies between builds, so the anchor is the
    // "A->A" arrow that every filter row has and no header line does.
    const m = line.match(/^\s*\S+\s+(\S+)\s+\S*->\S*/);
    if (m) present.add(m[1]);
  }
  return REQUIRED_FILTERS.filter(f => !present.has(f));
}

// True when the binaries in `dir` can actually run this chain. Exported
// because js/ffmpeg-setup.js reports the same verdict to the panel's log,
// and because a wrong answer here is a silently broken de-esser.
function verify(dir) {
  if (!hasBoth(dir)) return { ok: false, reason: 'ffmpeg or ffprobe missing' };
  const ffmpegPath = path.join(dir, 'ffmpeg' + EXE);
  const major = majorVersionOf(ffmpegPath);
  if (major == null) return { ok: false, reason: 'could not read its version' };
  if (major < MIN_FFMPEG_MAJOR) {
    return { ok: false, major, reason: `ffmpeg ${major}.x is too old (need ${MIN_FFMPEG_MAJOR}+)` };
  }
  const missing = missingFilters(ffmpegPath);
  if (missing.length) {
    return { ok: false, major, reason: `missing filters: ${missing.join(', ')}` };
  }
  return { ok: true, major, dir };
}

function foreignDir() {
  if (verifiedForeignDir !== undefined) return verifiedForeignDir;
  verifiedForeignDir = verify(AUDIOPRO_APP_DIR).ok ? AUDIOPRO_APP_DIR : null;
  return verifiedForeignDir;
}

// The directory the binaries will be taken from, or null when there is none.
function getBinDir() {
  for (const dir of candidateDirs()) {
    if (hasBoth(dir)) return dir;
  }
  return foreignDir();
}

function resolve(name) {
  const dir = getBinDir();
  if (dir) {
    const full = path.join(dir, name + EXE);
    if (fs.existsSync(full)) return full;
  }
  // PATH fallback, for a dev shell that has its own ffmpeg. It is not
  // verified, so the panel logs which binary it ended up with (see
  // js/ffmpeg-setup.js describe()) rather than assuming this is fine.
  return name + EXE;
}

// Mode 1's local denoise is unreachable from this panel (every sequence is
// paired with an Adobe pass, which is Mode 2), so the model is not shipped.
// pipeline.js treats null as "local denoise unavailable" and carries on.
function rnnoiseModel() {
  return null;
}

module.exports = {
  ffmpeg: () => resolve('ffmpeg'),
  ffprobe: () => resolve('ffprobe'),
  rnnoiseModel,
  getBinDir,
  verify,
  candidateDirs,
  extensionBinDir,
  SYSTEM_SUPPORT_DIR,
  USER_SUPPORT_DIR,
  AUDIOPRO_APP_DIR,
  MIN_FFMPEG_MAJOR,
  REQUIRED_FILTERS,
};
