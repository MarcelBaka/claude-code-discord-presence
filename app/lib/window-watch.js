'use strict';
// Claude desktop app watcher – platform specific part.
//
// Windows: window-watch.ps1 (WinAPI window visibility + UI Automation for the Code/chat
//   tab). Prints {"vis":{"<session pid>":bool},"app":{"visible":bool,"mode":"code|chat|unknown"}}.
// macOS: window-watch-mac.jxa run by /usr/bin/osascript (JavaScript for Automation).
//   Without any permission it reads, through AppKit/CoreGraphics: whether Claude.app runs,
//   whether it is hidden (Cmd+H) and whether it has a normal window on screen. Window
//   titles and the minimized flag need Accessibility (System Events), which is opt-in
//   (`macAccessibility: true`). Prints raw facts; macState() below decides.
// Other platforms: no watcher (nothing is hidden).
const path = require('path');

function watcherCommand({ platform = process.platform, appDir, daemonPid, pidFile, macAccessibility }) {
  if (platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(appDir, 'lib', 'window-watch.ps1'), '-DaemonPid', String(daemonPid), '-PidFile', pidFile] };
  }
  if (platform === 'darwin') {
    return { cmd: '/usr/bin/osascript', args: ['-l', 'JavaScript', path.posix.join(appDir, 'lib', 'window-watch-mac.jxa'), macAccessibility ? '1' : '0'] };
  }
  return null;
}

// Raw macOS facts → window state. Never guesses:
//   open        a normal window is on screen (or, with Accessibility, a non-minimized window exists –
//               e.g. on another Space)
//   hidden      the app is hidden (Cmd+H) – not closed
//   minimized   only with Accessibility: every window is minimized – not closed
//   closed      only with Accessibility: the app runs with no window (Cmd+W, stays in the Dock)
//   unknown     nothing on screen and no Accessibility – minimized, another Space or closed
//   not-running Claude.app is not running
function macState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ax = r.ax && typeof r.ax === 'object' ? r.ax : { status: 'off' };
  const out = { state: 'unknown', mode: 'unknown', accessibility: ax.status || 'off' };
  if (!r.running) { out.state = 'not-running'; return out; }
  if (ax.status === 'ok' && ['code', 'chat'].includes(ax.mode)) out.mode = ax.mode;
  if (r.onscreen > 0) out.state = 'open';
  else if (r.hidden) out.state = 'hidden';
  else if (ax.status === 'ok') {
    const w = Array.isArray(ax.windows) ? ax.windows : [];
    out.state = w.some(x => x && x.minimized === false) ? 'open' : w.some(x => x && x.minimized) ? 'minimized' : 'closed';
  }
  if (out.state !== 'open') out.mode = 'unknown';
  return out;
}

// Normalised form used by the daemon: vis[pid] === false only when the desktop app's
// window is known to be closed (or the app is gone); app.visible drives the chat card.
function fromMac(raw, pids) {
  const st = macState(raw);
  const closed = st.state === 'closed' || st.state === 'not-running';
  const vis = {};
  for (const p of pids || []) vis[String(p)] = !closed;
  return { vis, app: { visible: st.state === 'open', mode: st.state === 'open' ? st.mode : 'unknown' }, mac: st };
}

module.exports = { watcherCommand, macState, fromMac };
