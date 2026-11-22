'use strict';
// Optional start at Windows sign-in, so the regular Claude chat shows up on Discord even
// before any Claude Code session ran. Implemented as a small .vbs file in the user's
// Startup folder (visible in shell:startup, removed by `autostart off` and the uninstaller)
// that launches the background process with no console window.
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'Claude Code Discord Presence.vbs';

function startupDir() {
  if (process.env.CDP_STARTUP_DIR) return process.env.CDP_STARTUP_DIR;
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function filePath() { const d = startupDir(); return d ? path.join(d, FILE_NAME) : null; }

function isEnabled() { const f = filePath(); return !!f && fs.existsSync(f); }

function enable(nodePath, daemonPath) {
  const f = filePath();
  if (!f) throw new Error('autostart is only supported on Windows');
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

function disable() {
  const f = filePath();
  if (f && fs.existsSync(f)) { fs.rmSync(f, { force: true }); return true; }
  return false;
}

module.exports = { FILE_NAME, startupDir, filePath, isEnabled, enable, disable };
