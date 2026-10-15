#!/usr/bin/env bash
# Fetches the ffmpeg/ffprobe 8.1 arm64 binaries that the .pkg installs into
# /Library/Application Support/AudioPro/bin. Same source and the same pinned
# hashes as audio_education's scripts/fetch-bin.sh, because it has to be the
# same binary: the mastering chain uses filters whose options ffmpeg 6.1
# rejects outright (adynamicequalizer's mode/auto — see the de-esser section
# of audio_education/docs/PREMIERE-INTEGRATION.md §12).
#
# The RNNoise model is deliberately NOT fetched: it is only reachable from
# Mode 1, and this panel always pairs the original with an Adobe Podcast pass,
# which is Mode 2.
#
# plugin/bin is gitignored. It is also the first place plugin/core/bin-paths.js
# looks, so a dev checkout and CI resolve the binaries exactly the way an
# installed extension does.
#
# Usage: bash scripts/fetch-bin.sh [dest-dir]   (default: plugin/bin/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-$ROOT/plugin/bin}"

# Pinned SHA256 for the artefacts we trust. If osxexperts.net ever serves
# different bytes we abort rather than silently shipping a different binary
# inside the installer.
FFMPEG_ZIP_SHA256="ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad"
FFPROBE_ZIP_SHA256="a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1"

echo "▶ Populating $BIN with arm64 binaries"
mkdir -p "$BIN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

verify_sha256() {
  local file="$1" expected="$2"
  local actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "✗ SHA256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "  Refusing to install — upstream artefact may have been tampered with." >&2
    exit 1
  fi
}

fetch_osxexperts() {
  local name="$1" expected_sha="$2"
  local zip_url="https://www.osxexperts.net/${name}81arm.zip"
  echo "▶ Downloading $name ($zip_url)"
  curl -fsSL "$zip_url" -o "$TMP/$name.zip"
  verify_sha256 "$TMP/$name.zip" "$expected_sha"
  unzip -q -o "$TMP/$name.zip" -d "$TMP" "$name"
  install -m 0755 "$TMP/$name" "$BIN/$name"
  xattr -d com.apple.quarantine "$BIN/$name" 2>/dev/null || true
  local arch
  arch="$(file "$BIN/$name" | grep -oE 'arm64|x86_64' || echo unknown)"
  echo "  ✓ $name → $BIN/$name ($arch, sha256 verified)"
}

fetch_osxexperts ffmpeg "$FFMPEG_ZIP_SHA256"
fetch_osxexperts ffprobe "$FFPROBE_ZIP_SHA256"

# The whole point of pinning a specific build is the filter set, so check it
# rather than trusting the download.
MAJOR="$("$BIN/ffmpeg" -version | head -n 1 | sed -n 's/^ffmpeg version \([0-9]*\).*/\1/p')"
if [ -z "$MAJOR" ] || [ "$MAJOR" -lt 7 ]; then
  echo "✗ $BIN/ffmpeg reports major version '${MAJOR:-?}' — the chain needs 7 or newer" >&2
  exit 1
fi
# Matched against a shell variable instead of through a pipe. `grep -q` exits
# the moment it matches, the writer upstream then dies of SIGPIPE, and under
# `pipefail` that turns a *successful* match into a failed pipeline — which is
# exactly how this check first reported a filter as missing when it was there.
FILTERS="$("$BIN/ffmpeg" -hide_banner -filters 2>/dev/null)"
for filter in adynamicequalizer acrossover aexciter adeclick adeclip loudnorm alimiter; do
  # Each row is " TS <name> A->A  <description>", so the name is surrounded by
  # whitespace; matching it bare would let `adeclick` satisfy a search for a
  # filter whose name is a prefix of another.
  if [[ "$FILTERS" != *[[:space:]]"$filter"[[:space:]]* ]]; then
    echo "✗ $BIN/ffmpeg is missing the '$filter' filter" >&2
    exit 1
  fi
done

echo
echo "✓ Bundled binaries ready (ffmpeg $MAJOR.x, all required filters present):"
ls -lh "$BIN"
