# Claude Code Discord Presence

[![tests](https://github.com/MarcelBaka/claude-code-discord-presence/actions/workflows/test.yml/badge.svg)](https://github.com/MarcelBaka/claude-code-discord-presence/actions/workflows/test.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933.svg)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6.svg)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

Show what you are building with **Claude Code** on your Discord profile – the project, whether
Claude is working or waiting for you, the real number of tokens used, an estimated cost, the model
and a live timer.

```
┌──────────────────────────────────────────────┐
│ Watching ClaudeCode                          │
│ ┌──────┐                                     │
│ │ icon │  Project: My Web App                │
│ └────⚡┘  Working · 125.4k tokens · ~$2.31    │
│           ⏱ 42:13       [ View on GitHub ]   │
└──────────────────────────────────────────────┘
```

It starts by itself whenever you run Claude Code, follows the session you are actually using and
disappears when you close Claude. No bot, no account token, no dependencies – just the desktop
Discord client's local RPC and your own public Application ID.

> Not affiliated with Anthropic or Discord.

## Features

- **Zero setup after install** – global Claude Code hooks start one small background process; no
  server to run, no Windows autostart.
- **Real token usage** – read from the session transcript Claude Code writes, deduplicated per API
  response, subagents included. Never estimated from text length.
- **Working / waiting** – a small status badge and text show whether Claude is busy or waiting
  for your next prompt (also after you press Esc).
- **Estimated cost** at Anthropic API list prices, per model (Opus, Sonnet, Haiku, Fable…).
- **Model and effort** in the image tooltip, e.g. `Opus 5.5 · high effort`.
- **Today's totals** across all your sessions and projects, e.g. `Today: 1.2M tokens · ~$25`,
  rotating with the session line.
- **Project buttons** – an optional `View on GitHub` button for the projects you choose.
- **Native Discord timer** counting from when Claude Code was launched; it never resets on updates
  or reconnects.
- **Multiple sessions** – shows the session you last typed in; switches when one closes, even after
  a terminal crash.
- **Claude desktop app aware** – hides when you close the window, shows `Chatting with Claude` in
  the regular chat tab (optionally from sign-in, without a Code session).
- **One-command update** from GitHub.
- **Plays nicely with VS Code** – uses the “Watching” activity type, so it is shown next to (and
  below) the VS Code Discord extension instead of replacing it.
- **Private by design** – only the project name, token count, cost and timer are sent. Never
  prompts, code, file paths or repository URLs. Project names can be aliased or hidden.
- **Safe install** – backs up `settings.json`, never touches your existing hooks or status line,
  can be run again without creating duplicates, and uninstalls cleanly.

## Requirements

- Windows 10/11 with the **Discord desktop app** (the browser version has no local RPC)
- **Claude Code** (CLI or the Claude desktop app's Code tab)
- **Node.js 18+** on `PATH`

Linux and macOS code paths exist but are untested. WSL is not supported yet.

## Quick start

### 1. Create a Discord application (once, ~1 minute)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Pick a name – it is shown as the activity title (“Watching **ClaudeCode**”).
   Discord rejects some names containing “Claude”; `ClaudeCode` works.
3. On **General Information**, copy the **Application ID**.
4. *(Optional)* Upload an **App Icon** on the same page – it becomes the activity image automatically.

### 2. Install

```powershell
git clone https://github.com/MarcelBaka/claude-code-discord-presence.git
cd claude-code-discord-presence
node install.js --app-id <YOUR_APPLICATION_ID>
```

### 3. Restart Claude Code

Restart any open Claude Code sessions so they load the new hooks. That's it – the activity
appears on your profile as soon as a session starts or you send a prompt.

Check what is being sent at any time:

```powershell
node "$env:USERPROFILE\.claude\discord-presence\cli.js" status
```

## Commands

```powershell
node "$env:USERPROFILE\.claude\discord-presence\cli.js" <command>
```

| Command | What it does |
|---|---|
| `status` | Diagnostics: exact activity payload, Discord connection, sessions, token source and breakdown (`--json` for JSON) |
| `disable` / `enable` | Turn the integration off (clears the activity) / back on |
| `set-app-id <ID>` | Save or change the Application ID |
| `alias <folder> <name>` | Show a custom project name, e.g. `alias my-web-app "My Web App"` |
| `hide [<folder>]` / `unhide [<folder>]` | Hide one project name, or all of them (“Project hidden”) |
| `cost on\|off` | Show or hide the estimated cost |
| `status-icon on\|off` | Show whether Claude is working or waiting for you |
| `model on\|off` | Model and effort in the image tooltip |
| `today <rotate\|tooltip\|off>` | Today's totals: alternate with the session line every 20 s, show in the tooltip, or hide |
| `link <folder> [url]` | Add a button for a project; without a URL the Git `origin` remote is used |
| `unlink <folder>` | Remove the button |
| `autostart on\|off` | Start at Windows sign-in (chat tab shows up without a Code session) |
| `update` | Download the latest version from GitHub and reinstall (keeps your config) |
| `chat on\|off` | Show or hide the activity in the regular Claude chat tab |
| `type <watching\|playing\|competing\|listening>` | Discord activity type (see [VS Code](#using-it-with-the-vs-code-discord-extension)) |
| `tokens <no_cache_read\|all\|output>` | What the token counter includes (see [Tokens](#how-tokens-are-counted)) |
| `scope <launch\|conversation>` | Count since Claude was launched (default) or the whole conversation |
| `language <en\|pl>` | Language of the text on Discord |
| `image <auto\|key\|url\|none>` | Activity image: app icon (default), Art Asset key, image URL, or none |
| `count <file.jsonl> [since]` | Count tokens and cost in any transcript (for verification) |
| `project [dir]` | Preview the project name Discord will see |
| `stop` / `logs` | Stop the background process / show recent log lines |

## Configuration

Settings live in `%USERPROFILE%\.claude\discord-presence\config.json` and are picked up live.
The commands above edit it for you; [`config.example.json`](config.example.json) shows every key.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `applicationId` | `""` | Discord Application ID |
| `language` | `"en"` | `en` or `pl` |
| `aliases` | `{}` | `{ "folder-name or full path": "Display name" }` |
| `hideProject` / `hiddenProjects` | `false` / `[]` | Hide all / selected project names |
| `tokenCount` | `"no_cache_read"` | `no_cache_read`, `all` or `output` |
| `tokenScope` | `"launch"` | `launch` or `conversation` |
| `includeSubagents` | `true` | Count subagent usage |
| `showCost` | `true` | Append the estimated cost |
| `showStatus` | `true` | Working/waiting text and badge |
| `showModel` | `true` | Model and effort in the image tooltip |
| `showToday` | `"rotate"` | `rotate`, `tooltip` or `off` |
| `links` | `{}` | `{ "folder-name or full path": "https://…" }` – project buttons |
| `autostart` | `false` | Start at sign-in (set with `autostart on`) |
| `assetBaseUrl` | this repo's `assets/` | Where the status badges are loaded from |
| `updateRepo` | this repo | `owner/name` used by `update` |
| `pricing` | `{}` | Price overrides, e.g. `{ "claude-opus-5-5": { "input": 4, "output": 20 } }` |
| `activityType` | `"watching"` | `watching`, `playing`, `competing`, `listening` |
| `showChat` | `true` | Activity in the Claude desktop app's chat tab |
| `hideWhenWindowClosed` | `true` | Hide when the Claude desktop window is closed |
| `largeImageKey` / `largeImageText` | `""` / `"Claude Code"` | Image (empty = app icon) and its tooltip |
| `showSessionCount` | `false` | Append the number of open sessions |
| `logMaxBytes` | `524288` | Log size before rotation |

## Working, waiting, model and today

- **Working** starts when you send a prompt; **Waiting** when Claude finishes its reply (`Stop`
  hook), asks for your input (`Notification`), or you interrupt it with Esc (detected from the
  transcript, since no hook fires then). After 15 minutes without a reply or a hook, a stuck
  “Working” falls back to “Waiting”. The badge images live in [`assets/`](assets) and are loaded
  by Discord from GitHub.
- **Model and effort** come from the latest reply in the transcript (`message.model`, `effort`).
- **Today** sums every Claude Code transcript changed since local midnight – all projects, closed
  sessions and subagents too – with the same deduplication and token/cost rules as the session.

## Project buttons

```powershell
node "$env:USERPROFILE\.claude\discord-presence\cli.js" link C:\path\to\my-site
```

adds a **View on GitHub** button for that project (the URL comes from its `origin` remote; any
credentials in it are dropped). Only link public pages – the button is visible to everyone. Hidden
projects never get a button. Discord shows buttons to other people, not on your own view of your
profile.

## Autostart (optional)

By default the background process is started by Claude Code hooks. `autostart on` also starts it
at Windows sign-in, so opening the Claude desktop app straight into a chat shows
`Chatting with Claude` right away. It adds `Claude Code Discord Presence.vbs` to your Startup folder
(`shell:startup`), which launches Node with no window; the process then stays running (a few MB of
memory plus a small PowerShell window watcher). `autostart off` or uninstalling removes it.

## Updating

```powershell
node "$env:USERPROFILE\.claude\discord-presence\cli.js" update
```

downloads the `main` branch of this repository as a ZIP, runs its installer and keeps your
configuration. From a clone, `git pull` followed by `node install.js` does the same.

## How it works

```
claude ──hooks──▶ hook.js ──event file──▶ daemon.js ──local IPC──▶ Discord desktop
 (SessionStart, UserPromptSubmit, Stop,    │  ▲
  Notification, CwdChanged, SessionEnd)    │  └─ window-watch.ps1 (desktop app window & tab)
                                           └──── session transcript (.jsonl) → tokens & cost
```

- **`hook.js`** runs on six Claude Code events. It prints nothing (so nothing reaches Claude's
  context), records the session id, transcript path and project folder, starts the background
  process if needed and exits in ~0.2 s.
- **`daemon.js`** is a single background process (a named pipe guarantees only one instance). It
  keeps a registry of sessions, checks that each Claude process is still alive, reads transcripts
  incrementally and sends `SET_ACTIVITY` to Discord – only when something changed, at most 5 times
  per 20 s, with reconnects backing off from 2 s to 60 s.
- **Project name** = the Git repository's root folder (Git worktrees resolve to the main repo),
  otherwise the working directory's name. Only the name is ever published.

## How tokens are counted

- **Source:** the JSONL transcript Claude Code passes to hooks (`transcript_path`) plus subagent
  transcripts. Each API response is an `assistant` record with `message.id` and `message.usage`.
- Claude Code writes one line per content block (thinking, text, tool call), all with the same
  usage, so usage is keyed by `message.id` and **counted once**. Responses copied into another file
  (resume, fork) are counted once too.
- Partial lines wait until they are complete; rewritten files are recounted without duplicates.
- **Default counter** = input + cache writes + output – the tokens the model newly processed.
  Cache reads (the same context re-read on every call, often 95%+ of the total) are excluded;
  `tokens all` includes them.
- **Default scope** = since the current Claude process started, so resuming an old conversation
  does not add its history. `/clear` in the same window keeps counting.
- The status line's `context_window` values are **not** used – they describe the current context
  size, not usage over the session.
- No transcript → `Tokens: no data`, never a fake zero.

## Estimated cost

- Every response is priced by its own model using **all** usage components: input, output, cache
  reads and cache writes (5-minute and 1-hour priced separately). Fast mode counts 2×.
- Prices are Anthropic's API list prices in [`app/lib/pricing.js`](app/lib/pricing.js) (as of
  2026-11-03), e.g. Opus 5.5: $4 input / $20 output / $0.20 cache read per million tokens.
- **This is the API-equivalent value, not your bill** – Pro/Max subscriptions are not charged per
  token. Responses from models without a known price are left out and marked with `+`.

## Using it with the VS Code Discord extension

Discord displays only one **“Playing”** activity at a time, and the popular VS Code extension uses
“Playing”. This integration therefore defaults to **“Watching”**: both cards are visible on your
profile, VS Code is listed first and stays the status under your name. Prefer Claude on top?
`type competing`. Want them to compete for one slot? `type playing`.

## Claude desktop app

- **Window closed** (the app keeps running in the tray): the activity is hidden within ~2 s and
  comes back with the same timer when you reopen the window. A minimized window still counts.
- **Regular chat tab**: the card switches to `Chatting with Claude` with its own timer. Chats have
  no local transcript, so there are no tokens or cost for them.
- Both are detected by a small PowerShell watcher using the Windows window list and UI Automation.
  Only the tab type (Code/chat) is used – conversation titles never leave the watcher.

## Privacy

Sent to Discord: project name or alias (or “Project hidden”), Claude's working/waiting state,
token counts (session and today), estimated cost, model and effort, start time, images, and the
project buttons you add yourself. **Never** prompts, responses, file contents, paths or repository URLs. The hook
does not read prompt text, and nothing in this project ever calls a model.

The app icon is looked up once from Discord's public application endpoint using only your public
Application ID. Local diagnostics (`state\`, size-limited `logs\`) stay on your machine.

## Troubleshooting

| Problem | Try |
|---|---|
| Nothing on Discord | `cli.js status` – check `Application ID`, `Discord: connected` and the payload. Make sure *Settings → Activity Privacy → Share your activity* is on in Discord. |
| `Discord is not running` | Start the Discord desktop app; the integration reconnects by itself. |
| `Invalid Client ID` in `logs` | Re-copy the Application ID: `cli.js set-app-id <ID>`. |
| Only VS Code is visible | Use the default type: `cli.js type watching`. |
| Old app name or icon | Restart Discord (`Ctrl+R`); after changing the icon run `cli.js stop`. |
| Hooks not firing | Restart Claude Code; re-run `node install.js` (safe to repeat). |

## Uninstall

```powershell
node "$env:USERPROFILE\.claude\discord-presence\uninstall.js"
```

Clears the activity, stops the background process, removes **only** this project's hooks from
`settings.json` (after a backup) and deletes the install folder. Add `--keep-files` to keep the
configuration.

## Development

```powershell
node --test test/unit.test.js test/integration.test.js
```

Unit tests cover token counting, pricing, project names and `settings.json` merging. End-to-end
tests run the real `hook.js` and `daemon.js` against a fake Discord IPC server and fake Claude
processes: concurrent starts, Discord restarts, multiple projects, crashes, `/clear`, closing the
window, the chat tab, working/waiting (including Esc), today's totals, buttons and autostart.
GitHub Actions runs them on Windows with Node 18, 20 and 22. See [`docs/reports`](docs/reports) for the verification report.

### Known limitations

- The model call made by `/compact` itself is not in the transcript, so it is not counted.
- Without `autostart on`, opening the desktop app straight into a chat shows nothing until the
  first Claude Code event.
- Chat-tab detection relies on the Claude app's page title; an app update could change it.

## License

[MIT](LICENSE)
