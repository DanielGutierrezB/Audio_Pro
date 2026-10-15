#!/usr/bin/env bash
# Packs plugin/ as a ZXP (an unsigned zip: the panel's own updater unzips it
# straight over the installed extension, and PlayerDebugMode — which the .pkg
# sets — is what allows an unsigned extension to load at all).
#
# This is the *update* channel. First installs go through the .pkg
# (scripts/build-pkg.sh), which is also what puts ffmpeg on the machine, so
# the ZXP deliberately carries no binaries: a 2 MB update instead of an 80 MB
# one, and the installed bin/ survives the unzip untouched.
#
# Usage: scripts/build-zxp.sh [out.zxp]   (default: dist/audio-pro-<version>.zxp)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' plugin/CSXS/manifest.xml | head -n 1)
OUT=${1:-"dist/audio-pro-${VERSION}.zxp"}
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# The plugin's *contents* at the zip root, because the updater extracts it on
# top of the extension directory itself.
(
  cd plugin
  zip -r -q -X "$OLDPWD/$OUT" . -x ".debug" -x "bin/*" -x ".DS_Store" -x "**/.DS_Store"
)
echo "ZXP listo: $OUT (v$VERSION)"
