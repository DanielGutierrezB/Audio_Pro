#!/usr/bin/env bash
# Points this Mac's Premiere at the panel in this checkout, so a change is one
# panel reload away instead of a build + install.
#
#   ~/Library/Application Support/Adobe/CEP/extensions/com.danielgutierrez.audiopro
#       → symlink to <repo>/plugin
#
# What else it takes care of, because each one is a silent failure otherwise:
#   - PlayerDebugMode for CSXS 11-13: without it CEP ignores an unsigned
#     extension with no error and no menu entry.
#   - plugin/bin: the pinned ffmpeg/ffprobe, fetched if missing. bin-paths
#     looks there first, so the dev panel renders with the same binary CI
#     tests and the .pkg ships.
#   - An installed copy already in that location (from the .pkg) is moved to
#     ~/.audio-pro/installed-backup rather than deleted, so `--remove` can put
#     it back.
#
# The panel recognises the checkout (plugin/../.git) and then never
# self-updates over it; the .pkg's postinstall likewise leaves the symlink
# alone. Updating the dev panel is `git pull`.
#
# Usage: bash scripts/dev-install.sh            install / repair
#        bash scripts/dev-install.sh --remove   back to the installed copy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_ID="com.danielgutierrez.audiopro"
EXT_PARENT="$HOME/Library/Application Support/Adobe/CEP/extensions"
EXT="$EXT_PARENT/$BUNDLE_ID"
BACKUP="$HOME/.audio-pro/installed-backup"

if [ "${1:-}" = "--remove" ]; then
  if [ -L "$EXT" ]; then
    rm "$EXT"
    echo "✓ symlink removed"
  fi
  if [ -d "$BACKUP" ]; then
    mv "$BACKUP" "$EXT"
    echo "✓ installed copy restored ($(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$EXT/CSXS/manifest.xml" | head -n 1))"
  else
    echo "  no installed copy to restore — run the .pkg to get one"
  fi
  exit 0
fi

mkdir -p "$EXT_PARENT"
if [ -L "$EXT" ]; then
  rm "$EXT"
elif [ -e "$EXT" ]; then
  mkdir -p "$(dirname "$BACKUP")"
  rm -rf "$BACKUP"
  mv "$EXT" "$BACKUP"
  echo "✓ installed copy moved to $BACKUP"
fi
ln -s "$ROOT/plugin" "$EXT"
echo "✓ $EXT → $ROOT/plugin"

for v in 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo "✓ PlayerDebugMode on (CSXS 11-13)"

if [ ! -x "$ROOT/plugin/bin/ffmpeg" ] || [ ! -x "$ROOT/plugin/bin/ffprobe" ]; then
  bash "$ROOT/scripts/fetch-bin.sh"
else
  node -e '
    const v = require(process.argv[1]).verify(process.argv[2]);
    if (!v.ok) { console.error("✗ plugin/bin: " + v.reason + " — run: npm run setup:bin"); process.exit(1); }
    console.log("✓ plugin/bin has ffmpeg " + v.major + ".x with every filter the chain needs");
  ' "$ROOT/plugin/core/bin-paths.js" "$ROOT/plugin/bin"
fi

cat <<EOF

Listo. Abrí Premiere (si estaba abierto, cerralo y abrilo una vez) y
Ventana → Extensiones → Audio Pro. La pill dice "· dev".

  JS, HTML, CSS, host.jsx  → ⟳ en el panel (recarga y reinyecta host.jsx)
  CSXS/manifest.xml        → reiniciar Premiere
  Consola / DevTools       → http://localhost:8099  (login: 8100)
EOF
