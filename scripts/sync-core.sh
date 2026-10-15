#!/usr/bin/env bash
# Refreshes plugin/core/ from audio_education at the tag named in
# plugin/core/CORE_VERSION.js, and test/core/ from that same tag's suite.
#
# Why a copy at all: the panel runs the mastering chain itself, in the Node
# that CEP embeds, with no npm install and no AudioPro.app required. The cost
# of that is a second copy of the pipeline, which is exactly the failure mode
# audio_education/docs/PREMIERE-INTEGRATION.md §10 warns about — a broken
# de-esser survived months in that repo *with* tests. So the copy is pinned,
# byte-compared against the tag in CI (scripts/check-core.sh) and exercised by
# the tag's own test suite. Updating the pipeline is: bump CORE_VERSION.js,
# run this, commit the diff.
#
# bin-paths.js is ours and is never overwritten: upstream's resolves binaries
# inside an Electron app, this one inside a CEP extension.
#
# Usage: bash scripts/sync-core.sh [--into <dir>]
#   --into  write the core to <dir> instead of plugin/core (check-core.sh uses
#           this to produce a pristine tree to diff against)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_DEST="$ROOT/plugin/core"
TEST_DEST="$ROOT/test/core"
SYNC_TESTS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --into) CORE_DEST="$2"; SYNC_TESTS=0; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

VERSION_FILE="$ROOT/plugin/core/CORE_VERSION.js"
[ -f "$VERSION_FILE" ] || { echo "✗ missing $VERSION_FILE" >&2; exit 1; }
CORE_VERSION="$(sed -n "s/^module.exports = '\(.*\)';$/\1/p" "$VERSION_FILE")"
[ -n "$CORE_VERSION" ] || { echo "✗ could not read the tag from $VERSION_FILE" >&2; exit 1; }

UPSTREAM="https://github.com/DanielGutierrezB/Audio_Education.git"

# Modules the panel actually loads, plus whatever they require. enhance/ comes
# across whole rather than cherry-picked: a directory copied verbatim is a
# claim check-core.sh can verify, a hand-picked subset is a judgement call that
# rots.
CORE_MODULES=(
  pipeline.js
  metrics.js
  fusion.js
  align.js
  ffmpeg-run.js
  presets.js
  settings.js
  render-manifest.js
)
CORE_DIRS=(enhance)

# The upstream tests for those modules, so the copy is exercised by the suite
# that was written against it rather than only by ours.
CORE_TESTS=(
  pipeline.test.js
  fusion.test.js
  align.test.js
  metrics.test.js
  deesser.test.js
  adaptive-tone.test.js
  presets.test.js
  settings.test.js
  render-manifest.test.js
  enhance.test.js
  ffmpeg-run.test.js
  fixtures.js
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "▶ Cloning audio_education at $CORE_VERSION"
git clone --quiet --depth 1 --branch "$CORE_VERSION" "$UPSTREAM" "$TMP/src" \
  || { echo "✗ could not clone $UPSTREAM at tag $CORE_VERSION" >&2; exit 1; }

mkdir -p "$CORE_DEST/enhance"
for m in "${CORE_MODULES[@]}"; do
  cp "$TMP/src/src/$m" "$CORE_DEST/$m"
  echo "  ✓ core/$m"
done
for d in "${CORE_DIRS[@]}"; do
  rm -rf "${CORE_DEST:?}/$d"
  cp -R "$TMP/src/src/$d" "$CORE_DEST/$d"
  echo "  ✓ core/$d/ (whole directory)"
done

if [ "$SYNC_TESTS" = "1" ]; then
  mkdir -p "$TEST_DEST"
  for t in "${CORE_TESTS[@]}"; do
    # The only edit: the suite lives one level deeper here and the modules are
    # under plugin/core, not src/.
    sed "s|require('\.\./src/|require('../../plugin/core/|g" "$TMP/src/test/$t" > "$TEST_DEST/$t"
    echo "  ✓ test/core/$t"
  done
fi

echo
echo "✓ core synced from audio_education $CORE_VERSION"
echo "  bin-paths.js and CORE_VERSION.js are ours and were left untouched."
