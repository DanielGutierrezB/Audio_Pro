#!/usr/bin/env bash
# Fails when plugin/core/ has drifted from the audio_education tag it claims to
# be (plugin/core/CORE_VERSION.js). This is the whole reason a vendored copy is
# acceptable: one source of truth, enforced, instead of two codebases that
# agree until someone fixes a filter in only one of them.
#
# bin-paths.js and CORE_VERSION.js are ours by design and are excluded.
#
# Usage: bash scripts/check-core.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

bash "$ROOT/scripts/sync-core.sh" --into "$TMP/core" >/dev/null

if diff -r \
  --exclude=bin-paths.js \
  --exclude=CORE_VERSION.js \
  "$TMP/core" "$ROOT/plugin/core"; then
  echo "✓ plugin/core matches audio_education $(sed -n "s/^module.exports = '\(.*\)';$/\1/p" "$ROOT/plugin/core/CORE_VERSION.js")"
else
  cat >&2 <<'EOF'

✗ plugin/core/ differs from the tag in CORE_VERSION.js.

   Either the copy was edited by hand — don't: fix it upstream in
   audio_education, tag a release, bump CORE_VERSION.js and re-sync —
   or CORE_VERSION.js was bumped without running:

       npm run sync:core
EOF
  exit 1
fi
