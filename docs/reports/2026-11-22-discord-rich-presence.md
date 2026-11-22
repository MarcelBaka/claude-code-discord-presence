# Report: Discord Rich Presence for Claude Code – 2026-11-22

## Environment (checked)
- Windows 11 Pro 10.0.26200, native; WSL not installed.
- Claude Code CLI 2.1.310; desktop app sessions 2.1.330 (`entrypoint: claude-desktop`, `claude.exe` processes).
- Node v26.12.1; hooks run through Git Bash.
- Before installation: no hooks and no `statusLine` in `~/.claude/settings.json`.
- Discord desktop running, pipe `\\?\pipe\discord-ipc-0` available.
- Also running: VS Code with the `icrawl.discord-vscode` 5.9.2 extension, Spotify.

## What was built
- `hook.js` – global hooks SessionStart / UserPromptSubmit / CwdChanged / SessionEnd; silent, exits fast, starts the background process.
- `daemon.js` – one background process (named-pipe lock): session registry, Discord IPC, process liveness, token counting.
- `lib/discord-ipc.js` – minimal Discord IPC client (handshake, SET_ACTIVITY, ping/pong, close), no dependencies.
- `lib/tokens.js` – incremental JSONL transcript reader, dedup by `message.id`, subagents, launch-time scope.
- `lib/pricing.js` – estimated cost at Anthropic API list prices (as of 2026-11-03), per model, cache TTL split, fast mode.
- `lib/window-watch.ps1` – desktop app window visibility (WinAPI) and Code/chat tab detection (UI Automation).
- `cli.js`, `install.js`, `uninstall.js`, README, tests.

## Features added after the first version
1. Hide the activity when the Claude desktop app window is closed (app stays in the tray, sessions keep running); comes back with the same timer.
2. English text by default (`language: en|pl`), English CLI/README.
3. Activity image = the application's own icon from the Developer Portal (looked up from Discord's public endpoint), no Art Asset needed.
4. Estimated cost next to the tokens (`cost on|off`).
5. Activity type `watching` by default: Discord shows only one “Playing” activity, so with the VS Code extension only one was visible; with “Watching” both are shown and VS Code ranks above Claude (confirmed on the profile).
6. Regular Claude chat tab → `Chatting with Claude` with its own timer; back to Code restores the project and its original timer (confirmed on the profile).

## Tests (`node --test test/` → 21/21 pass)
| area | how | result |
|---|---|---|
| token counting and dedup | unit: blocks with the same message.id, updated record, partial line, truncated file, duplicate across files, subagent, launch filter, compact_boundary | pass |
| "no data" vs 0 | missing transcript | pass |
| project name | git root, worktree (.git file), spaces and Polish characters, alias, hiding, no path in the name | pass |
| settings.json | other hooks and statusLine preserved, idempotent, uninstall restores the original | pass + dry run on a copy of the real file |
| cost | prices per model, 5 min / 1 h cache writes, fast mode, unknown models, formatting, dedup | pass |
| autostart, no duplicates | 6 concurrent SessionStart hooks → 1 process; hook prints nothing, exit 0 | pass |
| Discord absent / restart | start without Discord → backoff → connect; Discord restart → reconnect, same `timestamps.start` | pass (fake IPC server) |
| several projects | switching on UserPromptSubmit; CwdChanged does not switch | pass |
| terminal crash | SIGKILL of the active session's process → switch to the other one | pass |
| closing | SessionEnd of the last session → activity cleared, process exits | pass |
| /clear, resume | same PID keeps timer and tokens; entries before launch excluded | pass |
| window closed / reopened | activity hidden, process stays, back with the same timer | pass |
| chat tab | chat activity, back to Code with the original timer, chat keeps the process alive, closing the window ends it | pass |
| privacy | payload without paths/user name; prompt not stored in registry or logs | pass |
| real Discord | activity, icon, cost, “Watching” type, chat card – confirmed by the user's screenshots | pass |
| real session | installed hook with real data: PID from `~/.claude/sessions`, token count equal to an independent `cli.js count` | pass |

## Limitations
- The model call made by `/compact` itself has no `usage` in the transcript → not counted (tokens and cost).
- Cost is the API-price equivalent, not a subscription bill; Haiku 5.5 long-prompt premium and Bedrock/Vertex prices are not modelled.
- Chat tab: no tokens/cost (no local transcript); the background process is started by Claude Code hooks, so a chat-only start after sign-in shows nothing until the first Claude Code event.
- Tab detection depends on the Claude app's page title/URL (` - Claude Code`); an app update could change it.
- Linux/macOS/WSL code paths exist but are untested.
