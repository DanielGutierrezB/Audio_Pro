#!/usr/bin/env bash
# The version is written in the CEP manifest — which is also what the panel
# reads at runtime to compare against the latest release, and what the updater
# reads back after installing — plus the two <Extension> entries inside it and
# package.json. They have to agree: CEP silently ignores an extension whose
# version disagrees with its bundle, and the release name comes from it.
#
# Usage: bash scripts/check-version.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/plugin/CSXS/manifest.xml"

bundle="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$MANIFEST" | head -n 1)"
pkg="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"

fail=0
note() { echo "✗ $1" >&2; fail=1; }

[ -n "$bundle" ] || note "no ExtensionBundleVersion in plugin/CSXS/manifest.xml"
[ -n "$pkg" ]    || note "no version in package.json"

[ "$pkg" = "$bundle" ] || note "package.json ($pkg) != manifest ($bundle)"

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

echo "✓ version $bundle consistent across the manifest and package.json"
