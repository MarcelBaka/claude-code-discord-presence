#!/bin/bash
# Claude Code Discord Presence – Linux installer.
# Run in a terminal: bash install-linux.sh   (or make it executable and double-click "Run in Terminal")
# Needs Node.js 18+ (https://nodejs.org or your distribution). Installs into
# ~/.claude/discord-presence, no sudo.
set -u
cd "$(dirname "$0")" || exit 1

finish() { echo; [ -t 0 ] && read -r -p "Press Enter to close… " _; exit "${1:-0}"; }

echo "Claude Code Discord Presence – installer for Linux"
echo

# Node.js: PATH first, then the usual install locations (a file manager may start this
# with a minimal PATH): distribution packages, Snap, Linuxbrew, nvm, fnm, volta, asdf
NODE=""
for c in "$(command -v node 2>/dev/null)" /usr/bin/node /usr/local/bin/node /snap/bin/node \
         /home/linuxbrew/.linuxbrew/bin/node "$HOME/.linuxbrew/bin/node" "$HOME/.local/bin/node" \
         "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" \
         $(ls -d "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -1) \
         $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -1); do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "Node.js was not found. Install Node.js 18+ (LTS) – from https://nodejs.org or your package"
  echo "manager (e.g. sudo apt install nodejs, sudo dnf install nodejs) – and run this installer again."
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
echo "Discord application: just press Enter to use the built-in \"ClaudeCode\" app – nothing to set up."
echo "Or paste the Application ID of your own app (Developer Portal → General Information)."
if [ -n "$SAVED" ]; then echo "Enter keeps your saved Application ID ($SAVED)."; fi
APP_ID=""
OK=""
for _ in 1 2 3; do
  read -r -p "Application ID (Enter = default): " APP_ID || APP_ID=""
  APP_ID="$(printf '%s' "$APP_ID" | tr -d '[:space:]')"
  if [ -z "$APP_ID" ] || printf '%s' "$APP_ID" | grep -Eq '^[0-9]{15,22}$'; then OK=1; break; fi
  echo "That does not look like an Application ID (a 17–20 digit number). Press Enter for the default."; APP_ID=""
done
[ -z "$OK" ] && { echo "No valid Application ID – nothing was installed."; finish 1; }

echo
if [ -n "$APP_ID" ]; then
  "$NODE" install.js --app-id "$APP_ID" || { echo; echo "Installation failed – see the messages above."; finish 1; }
else
  "$NODE" install.js || { echo; echo "Installation failed – see the messages above."; finish 1; }
fi

echo
read -r -p "Start automatically when you log in (desktop autostart)? [y/N] " AUTO || AUTO=""
CLI="${CDP_INSTALL_DIR:-$HOME/.claude/discord-presence}/cli.js"
case "$AUTO" in [yYtT]*) "$NODE" "$CLI" autostart on ;; esac

echo
echo "Done. Restart Claude Code (open a new terminal and run: claude) – the activity appears on Discord."
echo "Diagnostics: '$NODE' '$CLI' doctor"
finish 0
