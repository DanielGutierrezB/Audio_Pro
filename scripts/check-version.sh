#!/usr/bin/env bash
# The version appears in four places and they have to agree: the CEP manifest
# (what Premiere and the updater's "did it install?" check read), the two
# Extension entries inside it, package.json, and APP_VERSION in the panel
# (what the updater compares against the latest GitHub release). A panel that
# believes it is older than it is nags forever; one that believes it is newer
# never updates again.
#
# Usage: bash scripts/check-version.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/plugin/CSXS/manifest.xml"

bundle="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$MANIFEST" | head -n 1)"
pkg="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
app="$(sed -n "s/^var APP_VERSION = '\([^']*\)';.*/\1/p" "$ROOT/plugin/js/main.js" | head -n 1)"

fail=0
note() { echo "✗ $1" >&2; fail=1; }

[ -n "$bundle" ] || note "no ExtensionBundleVersion in plugin/CSXS/manifest.xml"
[ -n "$pkg" ]    || note "no version in package.json"
[ -n "$app" ]    || note "no APP_VERSION in plugin/js/main.js"

[ "$pkg" = "$bundle" ] || note "package.json ($pkg) != manifest ($bundle)"
[ "$app" = "$bundle" ] || note "APP_VERSION ($app) != manifest ($bundle)"

# Every <Extension Version="..."> has to match the bundle too: CEP silently
# ignores an extension whose version disagrees with its bundle.
while read -r v; do
  [ "$v" = "$bundle" ] || note "an <Extension Version=\"$v\"> disagrees with the bundle ($bundle)"
done < <(sed -n 's/.*<Extension Id="[^"]*" Version="\([^"]*\)".*/\1/p' "$MANIFEST")

if [ "$fail" = "1" ]; then
  echo >&2
  echo "Set all of them to the same value before tagging a release." >&2
  exit 1
fi

echo "✓ version $bundle consistent across manifest, package.json and APP_VERSION"
