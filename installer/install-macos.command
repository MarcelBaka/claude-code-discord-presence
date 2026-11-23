#!/bin/bash
# Claude Code Discord Presence – macOS installer.
# Double-click in Finder (first time: right-click → Open), or run: bash install-macos.command
# Needs Node.js 18+ (https://nodejs.org). Installs into ~/.claude/discord-presence, no sudo.
set -u
cd "$(dirname "$0")" || exit 1

finish() { echo; [ -t 0 ] && read -r -p "Press Enter to close this window… " _; exit "${1:-0}"; }

echo "Claude Code Discord Presence – installer for macOS"
echo

# Node.js: PATH first, then the usual install locations (the Finder/Terminal PATH may be minimal)
NODE=""
for c in "$(command -v node 2>/dev/null)" "$HOME/.local/opt/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node \
         "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -1); do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "Node.js was not found. Install the LTS version from https://nodejs.org and run this installer again."
  [ -t 1 ] && open "https://nodejs.org/en/download" 2>/dev/null
  finish 1
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$MAJOR" -lt 18 ] 2>/dev/null; then
  echo "Node.js $("$NODE" -v) is too old – version 18 or newer is needed (https://nodejs.org)."
  finish 1
fi
echo "Node.js: $NODE ($("$NODE" -v))"

# Application ID: keep the saved one if there is one
CFG="${CDP_INSTALL_DIR:-$HOME/.claude/discord-presence}/config.json"
SAVED="$("$NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).applicationId||""))}catch{}' "$CFG" 2>/dev/null)"
echo
echo "Discord Application ID – Developer Portal → your application → General Information."
if [ -n "$SAVED" ]; then echo "Press Enter to keep the saved one ($SAVED)."; fi
APP_ID=""
for _ in 1 2 3; do
  read -r -p "Application ID: " APP_ID || APP_ID=""
  APP_ID="$(printf '%s' "$APP_ID" | tr -d '[:space:]')"
  [ -z "$APP_ID" ] && [ -n "$SAVED" ] && APP_ID="$SAVED"
  if printf '%s' "$APP_ID" | grep -Eq '^[0-9]{15,22}$'; then break; fi
  echo "That does not look like an Application ID (a 17–20 digit number)."; APP_ID=""
done
[ -z "$APP_ID" ] && { echo "No valid Application ID – nothing was installed."; finish 1; }

echo
"$NODE" install.js --app-id "$APP_ID" || { echo; echo "Installation failed – see the messages above."; finish 1; }

echo
read -r -p "Start automatically at sign-in (LaunchAgent)? [y/N] " AUTO || AUTO=""
CLI="${CDP_INSTALL_DIR:-$HOME/.claude/discord-presence}/cli.js"
case "$AUTO" in [yYtT]*) "$NODE" "$CLI" autostart on ;; esac

echo
echo "Done. Restart Claude Code (or open a new Terminal and run: claude) – the activity appears on Discord."
echo "Diagnostics: '$NODE' '$CLI' status"
finish 0
