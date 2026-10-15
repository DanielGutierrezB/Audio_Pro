#!/usr/bin/env bash
# Builds the macOS installer: the panel, the ffmpeg/ffprobe it needs, and the
# postinstall that wires both into the logged-in user's Premiere.
#
# pkgbuild/productbuild rather than electron-builder, because there is no app
# here to bundle — the deliverable is a CEP extension plus two binaries, and
# the two tools ship with macOS.
#
# The payload stays root-owned under /Library/Application Support/AudioPro.
# pkg/scripts/postinstall is what copies the panel into ~/Library as the
# console user; see the long comment there for why that split exists.
#
# Set PKG_SIGN_IDENTITY to a "Developer ID Installer: ..." identity to sign
# (release.yml does this when the secrets exist). Unsigned otherwise, which
# means right-click → Open on first run.
#
# Usage: scripts/build-pkg.sh [out.pkg]
#        (default: dist/AudioPro-Premiere-<version>.pkg)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' plugin/CSXS/manifest.xml | head -n 1)
[ -n "$VERSION" ] || { echo "✗ could not read the version from plugin/CSXS/manifest.xml" >&2; exit 1; }
OUT=${1:-"dist/AudioPro-Premiere-${VERSION}.pkg"}
IDENTIFIER="com.danielgutierrez.audiopro.pkg"

for b in ffmpeg ffprobe; do
  [ -x "plugin/bin/$b" ] || {
    echo "✗ plugin/bin/$b is missing — run: npm run setup:bin" >&2
    exit 1
  }
done

ROOT="$(mktemp -d)"
SCRIPTS="$(mktemp -d)"
COMPONENT="$(mktemp -d)"
trap 'rm -rf "$ROOT" "$SCRIPTS" "$COMPONENT"' EXIT

SUPPORT="$ROOT/Library/Application Support/AudioPro"
mkdir -p "$SUPPORT/bin" "$SUPPORT/Premiere"

# The extension template. .debug (dev-only CEP debug port) and bin/ (the
# binaries live in the shared dir, not per-extension) are excluded; so is
# anything the editor or macOS left behind.
rsync -a \
  --exclude '.debug' \
  --exclude 'bin/' \
  --exclude '.DS_Store' \
  plugin/ "$SUPPORT/Premiere/extension/"

install -m 0755 plugin/bin/ffmpeg  "$SUPPORT/bin/ffmpeg"
install -m 0755 plugin/bin/ffprobe "$SUPPORT/bin/ffprobe"
install -m 0755 pkg/uninstall-premiere.sh "$SUPPORT/uninstall-premiere.sh"

install -m 0755 pkg/scripts/postinstall "$SCRIPTS/postinstall"

# A note for whoever sees `._`-prefixed entries when they expand the payload,
# or a stray "write: Permission denied" from pkgbuild: recent macOS stamps
# every file it creates with com.apple.provenance, that attribute cannot be
# removed (xattr -c reports success and the attribute stays), and pkgbuild
# represents it in the archive as an AppleDouble sidecar. It is a payload
# format artifact — the installer merges those back into file metadata, so
# nothing extra lands on the installed machine. Not worth chasing.

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

echo "▶ Building the component package"
pkgbuild \
  --root "$ROOT" \
  --scripts "$SCRIPTS" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location / \
  --ownership recommended \
  "$COMPONENT/AudioProPremiere.pkg" >/dev/null

echo "▶ Building the installer"
sign_args=()
if [ -n "${PKG_SIGN_IDENTITY:-}" ]; then
  sign_args+=(--sign "$PKG_SIGN_IDENTITY")
  echo "  · signing with: $PKG_SIGN_IDENTITY"
else
  echo "  · unsigned (no PKG_SIGN_IDENTITY) — users right-click → Open the first time"
fi

# macOS ships bash 3.2, where expanding an empty array trips `set -u`; the
# ${x[@]+...} guard expands to nothing instead of erroring.
productbuild \
  --distribution pkg/distribution.xml \
  --resources pkg/resources \
  --package-path "$COMPONENT" \
  ${sign_args[@]+"${sign_args[@]}"} \
  "$OUT" >/dev/null

echo "PKG listo: $OUT (v$VERSION)"
