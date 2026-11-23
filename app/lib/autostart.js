'use strict';
// Optional start at sign-in, so the background process runs before any Claude Code session
// (e.g. to show the regular Claude chat). Never required: hooks start the process anyway.
//
// Windows: a small .vbs file in the user's Startup folder (visible in shell:startup) that
//   launches the background process with no console window.
// macOS: a per-user LaunchAgent, ~/Library/LaunchAgents/<LABEL>.plist (no sudo), loaded
//   into the GUI session with launchctl. RunAtLoad only – no KeepAlive, so a process the
//   user stopped (`cli.js stop`, `disable`) is not restarted, and an instance that finds
//   another one already running simply exits without being respawned.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const FILE_NAME = 'Claude Code Discord Presence.vbs';
const LABEL = 'io.github.marcelbaka.claude-code-discord-presence';

const plat = o => (o && o.platform) || process.env.CDP_AUTOSTART_PLATFORM || process.platform;

// ---------- Windows ----------
function startupDir() {
  if (process.env.CDP_STARTUP_DIR) return process.env.CDP_STARTUP_DIR;
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

// ---------- macOS ----------
function launchAgentsDir() { return process.env.CDP_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents'); }

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function plistXml(nodePath, daemonPath) {
  const str = v => `<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <!-- Claude Code Discord Presence: starts the background process at sign-in. Remove with: node cli.js autostart off -->',
    `  <key>Label</key>${str(LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${str(nodePath)}`,
    `    ${str(daemonPath)}`,
    `    ${str('--standby')}`,
    '  </array>',
    `  <key>WorkingDirectory</key>${str(path.dirname(daemonPath))}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>PATH</key>${str('/usr/bin:/bin:/usr/sbin:/sbin')}`,
    `    <key>LANG</key>${str('en_US.UTF-8')}`,
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><false/>',
    `  <key>LimitLoadToSessionType</key>${str('Aqua')}`,
    `  <key>ProcessType</key>${str('Interactive')}`,
    `  <key>StandardOutPath</key>${str('/dev/null')}`,
    `  <key>StandardErrorPath</key>${str('/dev/null')}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// launchctl is optional for the file itself (tests set CDP_LAUNCHCTL=none); failures
// are reported, never thrown past the caller's file changes.
function launchctl(args) {
  const bin = process.env.CDP_LAUNCHCTL || '/bin/launchctl';
  if (bin === 'none') return { ok: true, skipped: true };
  try { execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }); return { ok: true }; } catch (e) {
    return { ok: false, error: String((e.stderr && e.stderr.toString().trim()) || e.message) };
  }
}
const domain = () => `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}`;

// ---------- common API ----------
function filePath(o) {
  const p = plat(o);
  if (p === 'darwin') return path.join(launchAgentsDir(), `${LABEL}.plist`);
  const d = startupDir();
  return d ? path.join(d, FILE_NAME) : null;
}

function isEnabled(o) { const f = filePath(o); return !!f && fs.existsSync(f); }

// Returns the file path; `result.launchctl` (macOS) tells whether loading worked now.
function enable(nodePath, daemonPath, o) {
  const p = plat(o);
  const f = filePath(o);
  if (p === 'darwin') {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, plistXml(nodePath, daemonPath), { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, f);
    launchctl(['bootout', `${domain()}/${LABEL}`]); // reload with the new paths (ignore "not loaded")
    const r = launchctl(['bootstrap', domain(), f]);
    enable.lastLaunchctl = r;
    return f;
  }
  if (!f) throw new Error('autostart is supported on Windows and macOS only');
  const q = s => `""${s.replace(/"/g, '')}""`;
  const vbs = [
    "' Claude Code Discord Presence - starts the background process at sign-in (no window).",
    "' Remove with: node cli.js autostart off",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${q(nodePath)} ${q(daemonPath)} --standby", 0, False`,
    '',
  ].join('\r\n');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // UTF-16LE with BOM so paths with non-ASCII characters work in wscript
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
  return f;
}

// Removes only our own file (and, on macOS, unloads only our own label).
function disable(o) {
  const p = plat(o);
  const f = filePath(o);
  if (p === 'darwin') {
    const had = !!f && fs.existsSync(f);
    if (had) launchctl(['bootout', `${domain()}/${LABEL}`]);
    if (had) fs.rmSync(f, { force: true });
    return had;
  }
  if (f && fs.existsSync(f)) { fs.rmSync(f, { force: true }); return true; }
  return false;
}

module.exports = { FILE_NAME, LABEL, startupDir, launchAgentsDir, plistXml, filePath, isEnabled, enable, disable };
