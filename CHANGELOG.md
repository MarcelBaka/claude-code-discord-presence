# Changelog

All notable changes to this project. Versions follow [semantic versioning](https://semver.org);
each release's notes on GitHub are built from its section here plus the list of merged pull
requests. Add your change under the version in `app/version.json` when you open a pull request.

## 1.3.0 – 2026-11-23

### Added
- **"Get this plugin" button** on the card, linking to this repository, so people who see your
  profile can find the project (`promo off` hides it; next to a project's own button there is room
  for both).
- **`cli.js doctor`** – checks Node, the hooks, the install folder, Discord, the background
  process, tracked sessions, autostart and recent log errors, and says what to do.
- **`pause [duration]` / `resume`** – hide the card for a while (`30m`, `1h`, `2h30m`, `forever`);
  it comes back by itself.
- **Away state** – `away 30` makes the card say *Away* after 30 minutes of waiting for your prompt
  (off by default).
- **Automatic updates** (opt-in, `auto-update on`) – a newer release is installed by itself, only
  while Claude is not working; the background process restarts with the new version.
- **Price table from the repository** – prices live in `app/pricing.json` and are refreshed from
  the repository once a day (validated numbers only, never older than the installed table), so a
  new model gets a price without a new release. `prices` shows the date in use.
- **CHANGELOG** and release notes built from it plus the merged pull requests.

## 1.2.0 – 2026-11-23

### Added
- Built-in Discord application ("ClaudeCode"): no Application ID needed – just press Enter in the
  installer. Your own application still works (`set-app-id <ID>`, `set-app-id default`).

## 1.1.0 – 2026-11-23

### Added
- What Claude is doing: *Thinking*, *Editing files*, *Reading code*, *Running commands*, … from an
  async `PreToolUse` hook (categories only, never tool input).
- Versioned installs (`app/version.json`), `cli.js version` and a daily check for new releases.
- `update` installs the latest release (or `--main`, or a given version) instead of the main branch.

### Fixed
- A resumed conversation was bound to the dead process left in `~/.claude/sessions` and dropped.
- Chat-tab detection on Windows read the app shell instead of the claude.ai page.
- A slow `ps` result could drop a session that had just moved to a new process (macOS/Linux).
- A late async `PreToolUse` could reopen a finished turn; events are now matched by `prompt_id`.

## 1.0.1 – 2026-11-23

### Fixed
- macOS: the plain window title is never taken as the chat tab; status in chat mode.

## 1.0.0 – 2026-11-23

### Added
- First release: project, session tokens, estimated cost and a native timer on your Discord
  profile; working/waiting status, model and effort, today's totals, project buttons, autostart,
  desktop app window and chat-tab awareness, `update`; Windows and macOS (Apple Silicon and Intel)
  with double-click installers.
