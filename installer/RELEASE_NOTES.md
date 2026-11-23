## Downloads

| System | File | How to install |
|---|---|---|
| **macOS** (Apple Silicon and Intel) | `claude-code-discord-presence-*-macos.zip` | Unzip, then double-click **`install-macos.command`**. The first time macOS may refuse to open a downloaded script: right-click it → **Open** → **Open**. |
| **Windows 10/11** | `claude-code-discord-presence-*-windows.zip` | Unzip (Extract All), then double-click **`install-windows.cmd`**. If SmartScreen appears: **More info** → **Run anyway**. |

Before you start: install **Node.js 18+** (LTS) from https://nodejs.org – the installer checks for it.

When the installer asks for a Discord Application ID, **just press Enter**: the built-in “ClaudeCode” app is used and there is nothing to set up on Discord. (Your own app for a custom title or icon: paste its Application ID instead – see the README.)

The installer copies the files to `~/.claude/discord-presence` (Windows: `%USERPROFILE%\.claude\discord-presence`), adds the Claude Code hooks (after a backup of `settings.json`) and can optionally turn on start at sign-in. Then restart Claude Code. The scripts are not code-signed; they only run `node install.js` from the unzipped folder – read them before running if you like.

Uninstall: `node ~/.claude/discord-presence/uninstall.js` (Windows: `node "%USERPROFILE%\.claude\discord-presence\uninstall.js"`).
