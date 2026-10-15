#!/bin/bash
# Removes everything the installer put on this machine.
#
# Deliberately leaves alone:
#   - Audio_Process/ next to your projects — those are your exports, your
#     Adobe passes and your masters, and some of them are linked from open
#     sequences.
#   - ~/.adobe-podcast-premiere-token — shared with the Adobe Podcast Enhance
#     panel, which may still be installed and signed in.
#   - PlayerDebugMode — other unsigned extensions may depend on it.
#
# Usage: sudo bash "/Library/Application Support/AudioPro/uninstall-premiere.sh"
set -e

SUPPORT_DIR="/Library/Application Support/AudioPro"
BUNDLE_ID="com.danielgutierrez.audiopro"

[ "$(id -u)" = "0" ] || { echo "Run with sudo." >&2; exit 1; }

CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null || echo '')"
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ]; then
  USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [ -n "$USER_HOME" ] || USER_HOME="/Users/$CONSOLE_USER"
  EXT_DIR="$USER_HOME/Library/Application Support/Adobe/CEP/extensions/$BUNDLE_ID"
  if [ -e "$EXT_DIR" ]; then
    rm -rf "$EXT_DIR"
    echo "✓ panel removed ($EXT_DIR)"
  fi
  if [ -d "$USER_HOME/.audio-pro" ]; then
    rm -rf "$USER_HOME/.audio-pro"
    echo "✓ settings and cache removed (~/.audio-pro)"
  fi
fi

if [ -d "$SUPPORT_DIR" ]; then
  rm -rf "$SUPPORT_DIR"
  echo "✓ ffmpeg and support files removed ($SUPPORT_DIR)"
fi

pkgutil --forget com.danielgutierrez.audiopro.pkg >/dev/null 2>&1 || true

echo
echo "Done. Your Audio_Process/ folders were left untouched."
