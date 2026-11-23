# Report: macOS support – 2026-11-23

## Environment actually used
- **Mac:** macOS 13.7.8 (22H730), **Intel x86_64**. No Apple Silicon machine was available locally.
- **Node:** v22.23.5 darwin-x64 (official nodejs.org tarball, SHA-256 verified, run from a temporary folder – the Mac had no Node installed).
- **Claude:** Claude desktop app with its bundled Claude Code 2.1.330 (`entrypoint: claude-desktop`).
- **Discord:** desktop client running; socket `$TMPDIR/discord-ipc-0` (`/var/folders/…/T/`).
- **Windows:** not available in this session – the Windows paths were kept, reviewed and their tests made platform-explicit, but they were **not executed** here (CI covers them).

## Why macOS did not work before
| Area | Cause |
|---|---|
| Tests | `integration.test.js` hard-coded `\\.\pipe\…` names. On macOS these became socket files named `\\.\pipe\cdp-test-…` inside the repository folder and the suite hung. |
| Single instance | `probe → unlink → listen`: hooks starting at the same time after a crash all see a refused connection and each unlinks the previous one's fresh socket. Reproduced with the old code (8 simultaneous starts after a `SIGKILL`, 6 rounds): **2–3 daemons in 3 of 6 rounds**. |
| Socket path | `state/daemon.sock` under a long data directory can exceed the 104-byte `sun_path` limit → `listen` fails. |
| Discord socket | Only the first of `XDG_RUNTIME_DIR`/`TMPDIR`/`TMP`/`TEMP` was tried. A daemon started with a different environment (launchd has no `TMPDIR`) would never find `/var/folders/…/T/discord-ipc-0`. |
| Claude PID | `resolveFromTree()` returned immediately on non-Windows; PID reuse was only checked with `tasklist`. Without a `~/.claude/sessions` entry the session could never detect Claude exiting. |
| Hook command | `"path"` quoting: inside `sh -c` double quotes still expand `$`, `` ` ``, `\` and (interactive) `!`. Node path was `process.execPath`, i.e. the versioned Homebrew Cellar path that breaks on `brew upgrade`. |
| Desktop watcher | Only `window-watch.ps1` (WinAPI/UI Automation); never started on macOS. |
| Autostart | Windows-only (Startup folder VBS); `autostart on` threw on macOS. |
| Updater | Unconditionally ran `powershell.exe Expand-Archive` with a command string; `process.exit` inside skipped cleanup of the temp folder. |

## What changed
| File | Change |
|---|---|
| `app/lib/common.js` | `pipeName()`: Unix socket in `state/`, or (path > 100 bytes) in a per-user `0700` folder `/tmp/cdp-<uid>/<sha256(dataDir)>.sock`; refuses symlinked/foreign/group-accessible folders. `privateDir()`, `ensurePrivateDirs()`; `macAccessibility` default. Shared by hook, daemon, CLI, installer, uninstaller. |
| `app/lib/singleton.js` (new) | `listen`, the probe and the removal of a stale socket all happen under one short `mkdir` lock next to the socket; only a socket owned by the user is removed; shutdown unlinks only the socket inode it created. |
| `app/lib/discord-ipc.js` | All env candidates + `getconf DARWIN_USER_TEMP_DIR` + `/tmp` (+ `/run/user/<uid>`, Flatpak, Snap on Linux), deduplicated, indices 0–9; nonexistent Unix paths skipped instantly. `CDP_DISCORD_IPC_DIRS` for tests. |
| `app/lib/proc.js` (new) | `/bin/ps` via `execFile` (`LC_ALL=C`): `pid ppid lstart comm` (comm last → paths with spaces), command lines only for Node processes; Claude recognition (native `claude`, desktop-bundled `claude`, Node + `@anthropic-ai/claude-code`; never `Claude.app`, its helpers, shells or our hook); ancestor walk; start times. |
| `app/hook.js` | `umask 077`; on SessionStart/UserPromptSubmit without a `~/.claude/sessions` entry, records its ancestors synchronously (the intermediate `sh` exits right after the hook). |
| `app/daemon.js` | macOS tree fallback (hook ancestors, then `ps` from the hook's parent, retried every 30 s); identity = process start time compared with Claude's own `procStart` record (UTC or local) and re-checked every 15 s; `dropSession()`; platform-split window watcher; singleton listen + own-socket release; status shows macOS window/Accessibility state. |
| `app/lib/window-watch.js`, `window-watch-mac.jxa` (new) | macOS watcher via `osascript -l JavaScript`: running / hidden / on-screen windows without permissions; minimized flag and title-derived tab only with opt-in Accessibility; `macState()` never guesses. |
| `app/lib/autostart.js` | macOS LaunchAgent (`~/Library/LaunchAgents/io.github.marcelbaka.claude-code-discord-presence.plist`): XML-escaped absolute paths, own `PATH`, `RunAtLoad`, no `KeepAlive`, `LimitLoadToSessionType=Aqua`; `launchctl bootout` + `bootstrap gui/<uid>`; removes only its own label/file. Windows VBS unchanged. |
| `app/lib/settings.js` | POSIX single-quote escaping for hook commands on macOS/Linux; Windows format unchanged. |
| `app/lib/nodepath.js` (new) | Homebrew Cellar path → stable `opt/<formula>/bin/node` or `bin/node` link if it resolves to the same binary. |
| `app/lib/updater.js` (new), `app/cli.js` | `ditto -x -k` on macOS, `unzip` on Linux, the built-in `tar.exe` on Windows (replaced `Expand-Archive`: it unpacked nothing usable in CI); ZIP signature check; installer exit checked; temp folder removed in `finally`; failures exit 1. New `mac-accessibility on|off`; macOS-aware `status` and `autostart`. |
| `install.js`, `app/uninstall.js` | Stable absolute Node path in hooks/LaunchAgent, LaunchAgent rewritten on reinstall when enabled, macOS command hints; uninstaller removes a stale own socket and the empty `/tmp/cdp-<uid>` folder. |
| `test/*.js`, `.github/workflows/test.yml` | See below. |
| `README.md` | Requirements/support table, Terminal commands, install/diagnostics/update/uninstall, autostart, Accessibility, desktop limits. |

Not used: the hook "exec form" (`args`, no shell) documented for current Claude Code – older Claude Code versions would ignore `args` and run `node` with no script (reading the hook JSON from stdin as code), so the portable shell form with correct quoting was kept.

## Tests run (macOS 13.7.8 Intel, Node 22.23.5)
`node --test test/unit.test.js test/integration.test.js` → **45/45 pass, 0 skipped, 0 cancelled** in each of the 4 final full runs (after the lock fix below). Earlier full runs, before that fix, had one failure in ~6 runs in the orphaned-socket lock test – the race described below.

| Area | How | Result |
|---|---|---|
| All previous functional tests | unchanged scenarios, now over real Unix sockets (`/tmp/cdp-it-*`) | pass |
| Concurrent start → one daemon | 6 simultaneous hooks; 8 simultaneous `listenExclusive` processes | pass (exactly 1 owner) |
| Orphaned socket | listener killed with `SIGKILL`, 6 simultaneous takers; daemon killed with `SIGKILL`, 6 simultaneous hooks | pass (removed exactly once, one new daemon, timer kept) |
| Socket privacy / cleanup | socket mode `0600`, state dirs `0700`, own socket removed at shutdown, symlink in `/tmp` refused, long-path fallback ≤ 103 bytes | pass |
| PID without session registry | fake `claude` → `sh -c '<installed command>'` → hook; shell gone when the daemon looks | pass (PID = Claude, `pidVia: process-tree`; exit detected) |
| PID reuse | live process whose start ≠ Claude's `procStart` dropped, genuine one kept | pass |
| Live `ps` | ancestors of the test process; start time vs. `process.uptime()`; on this Mac also manually: hook → … → desktop-bundled `claude` (PID 1100, start equals `~/.claude/sessions/1100.json` `procStart`) | pass |
| Quoting | install path with space, `'`, `"`, `$HOME`, backticks, `!`, `&`, `;`, `\`, `ż` executed through `/bin/sh -c` | pass |
| Install → reinstall → uninstall | awkward home path, foreign hooks/statusLine, byte-identical reinstall, App ID kept, LaunchAgent rewritten, installed hook run via `sh -c` starts the daemon, uninstall restores the original settings | pass |
| LaunchAgent | `plutil -lint`, `plutil -extract`, XML escaping, `launchctl` calls (fake binary), foreign agents untouched | pass |
| Updater | real `ditto` unpack + installer; installer exit 3, non-ZIP, HTTP error, bad repo → rejected; temp folders removed | pass |
| Discord reconnect / timer & tokens | fake Discord stopped/started, launched after Claude; socket in 2nd directory at index 3 | pass |
| macOS desktop states | watcher-format input: hidden/minimized/unknown/denied keep the card, closed hides it, back with the same timer; JXA watcher run for real without permissions | pass |
| Old lock scheme (for comparison) | reproduction script, see table above | 2–3 daemons in 3/6 rounds |
| New lock, stress | 25 rounds × 12 simultaneous processes (every second round with a socket orphaned by `SIGKILL`) | exactly 1 owner in 25/25 |

**Found and fixed during testing:** the first version of the new lock only took the lock for the removal step. Repeated runs failed 1 time in ~6: a process probed a peer's socket in the instant between that peer's `bind()` and `listen()` (a bound but not yet listening socket refuses connections), treated it as orphaned and removed it → two owners. Now binding happens under the same lock, so a probe can never see a half-started peer. After the fix: the two lock tests 15× in a row and the stress run above without a failure.

### Real Discord (manual, this Mac)
- Socket discovery found `/var/folders/…/T/discord-ipc-0`; a handshake with a deliberately **invalid** client ID got Discord's close frame `Invalid Client ID (4000)` – proves path and framing. **No activity was set**: no real Application ID was used and nothing was published to the profile.
- **Not verified with a real Discord account:** the activity card on macOS, reconnect after a real Discord restart, clearing after a real Claude Code CLI session. Those are covered only by the fake IPC server.

## Platforms and architectures
| | Verified |
|---|---|
| macOS Intel x64 | full suite locally (above) |
| macOS Apple Silicon arm64 | **not run** – CI job `macos-latest` (Node 20/22/24) configured; the job asserts `process.arch === arm64` |
| macOS Intel in CI | job `macos-15-intel` (Node 22) configured, asserts `x64`; GitHub's Intel images are being phased out – replace the label if it is retired |
| Windows | **not run here**; CI jobs Node 18/20/22 kept; Windows-only tests now pass `platform: 'win32'` explicitly |
| Linux | not tested (code paths only) |

## Remaining limitations
- Without Accessibility, macOS cannot tell a minimized window, a window on another Space and a closed window apart → the card stays (state `unknown`); the chat card is not shown.
- With Accessibility: the minimized/closed logic follows the macOS AX window list, but the Code/chat tab is derived from the window title with the same patterns as on Windows – **not verified** on a real Mac (titles were not readable here without granting permissions, which was intentionally not done). TCC attributes the permission to the app that launched Claude (Terminal, iTerm, Claude) or to `osascript`/`node` under launchd.
- `autostart off` on macOS unloads the job; a standby process it started is stopped (the next Claude event starts the daemon again when sessions are open).
- Version-manager Node paths (nvm, fnm…) are per version: re-run the installer after removing that version.
- The hook's ancestor snapshot costs ~20–80 ms, only when Claude's registry has no entry for the session.

## Manual checklist – Mac with a real Discord
1. `node -v` (≥ 18) → `git clone … && cd claude-code-discord-presence && node install.js --app-id <ID>`.
2. `grep discord-presence ~/.claude/settings.json` – six hooks, paths in single quotes, absolute Node path.
3. Start Discord; *Settings → Activity Privacy → Share my activity* on.
4. New Terminal → `cd` into a Git project → `claude` → send a prompt.
5. Profile shows `Project: <name>`, timer, `Working`/`Waiting`, tokens; `node ~/.claude/discord-presence/cli.js status` shows `Discord: connected`, the session with `PID … (claude-sessions)` and the payload.
6. Quit Discord (⌘Q), wait 10 s, start it again → card returns with the **same** timer.
7. Open a second `claude` in another project, type there → card switches; close that Terminal window → back to the first.
8. `/exit` in the last session → card disappears within ~20 s; `status` → background process not running.
9. Optional: `cli.js autostart on` → `launchctl print gui/$UID/io.github.marcelbaka.claude-code-discord-presence`; log out/in; `cli.js autostart off` → file gone.
10. Optional: Claude desktop app Code tab → card; ⌘H / minimize → card stays; `cli.js mac-accessibility on`, grant permissions, close the window with ⌘W → card hidden; check `status` for `Accessibility: ok`.
11. `node ~/.claude/discord-presence/uninstall.js` → hooks gone, other settings intact.
