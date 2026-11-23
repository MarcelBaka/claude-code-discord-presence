'use strict';
// Process table on macOS (and other Unix systems) through the system `ps`, run with
// execFile (no shell). Used to find the Claude Code process behind a hook when
// ~/.claude/sessions has no entry for the session, and to check that a PID still
// belongs to the same process (start time), so a reused PID cannot keep a session alive.
//
// Columns: `pid ppid lstart comm` – lstart is always 5 tokens ("Mon Nov 23 09:04:55 2026"
// with LC_ALL=C) and comm is the last column, so executable paths with spaces
// ("Application Support") parse unambiguously. Command lines are read separately and
// only for the few processes that need it (Node running Claude Code).
const { execFile, execFileSync } = require('child_process');
const path = require('path');

const PS = process.env.CDP_PS || '/bin/ps';
const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) };
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const LSTART = '[A-Z][a-z]{2}\\s+([A-Z][a-z]{2})\\s+(\\d{1,2})\\s+(\\d{1,2}):(\\d{2}):(\\d{2})\\s+(\\d{4})';

// "Mon Nov 23 09:04:55 2026" (local time, as printed by ps) → epoch ms
function parseLstart(s, utc = false) {
  const m = new RegExp(`^\\s*${LSTART}\\s*$`).exec(String(s || ''));
  if (!m || !(m[1] in MONTHS)) return null;
  const a = [+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]];
  return utc ? Date.UTC(...a) : new Date(...a).getTime();
}

function parseTable(out) {
  const re = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${LSTART})\\s+(.+?)\\s*$`);
  const map = new Map();
  for (const line of String(out).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    map.set(+m[1], { pid: +m[1], ppid: +m[2], start: parseLstart(m[3]), comm: m[10] });
  }
  return map;
}

function parseArgs(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) { const m = /^\s*(\d+)\s(.*)$/.exec(line); if (m) map.set(+m[1], m[2].trim()); }
  return map;
}

const TABLE = ['-axww', '-o', 'pid=,ppid=,lstart=,comm='];
const opts = { env: ENV, timeout: 5000, maxBuffer: 32 << 20, windowsHide: true, encoding: 'utf8' };

function listProcesses(cb) { execFile(PS, TABLE, opts, (err, out) => cb(err, err ? null : parseTable(out))); }
// sync variants run inside the hook – short timeout, the hook must never hold Claude up
function listProcessesSync() { return parseTable(execFileSync(PS, TABLE, { ...opts, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })); }
function argsSync(pids) {
  if (!pids.length) return new Map();
  try { return parseArgs(execFileSync(PS, ['-ww', '-o', 'pid=,args=', '-p', pids.join(',')], { ...opts, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { return parseArgs(e.stdout || ''); }
}
function args(pids, cb) {
  if (!pids.length) return cb(null, new Map());
  // ps exits 1 when some PIDs are gone – the output for the others is still valid
  execFile(PS, ['-ww', '-o', 'pid=,args=', '-p', pids.join(',')], opts, (err, out) => cb(null, parseArgs(out || '')));
}

// Start time of each given PID that still exists (others are missing from the map).
function startTimes(pids, cb) {
  if (!pids.length) return cb(null, new Map());
  execFile(PS, ['-o', 'pid=,lstart=', '-p', pids.join(',')], opts, (err, out) => {
    if (err && !out) {
      // exit status 1 with empty output = none of the PIDs exist; anything else is a real failure
      return cb(err.code === 1 ? null : err, new Map());
    }
    const map = new Map();
    for (const line of String(out).split('\n')) { const m = new RegExp(`^\\s*(\\d+)\\s+(${LSTART})`).exec(line); if (m) map.set(+m[1], parseLstart(m[2])); }
    cb(null, map);
  });
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'login', 'env', 'nohup', 'timeout']);
// Is this process Claude Code itself? Native installs and the copy bundled with the
// Claude desktop app run an executable named `claude`; npm installs run Node with the
// @anthropic-ai/claude-code package. The desktop app itself (`Claude`, capital C),
// its helpers, shells and our own hook never match.
function isClaude(proc, cmdline) {
  if (!proc) return false;
  const base = path.basename(String(proc.comm || ''));
  if (base === 'claude' || base === 'claude.exe') return true;
  if (SHELLS.has(base.replace(/^-/, ''))) return false;
  if (/^(node|nodejs|bun)(\.exe)?$/i.test(base) && cmdline) {
    if (/discord-presence[\\/]/.test(cmdline)) return false;
    return /@anthropic-ai[\\/]claude-code|claude-code[\\/](cli|dist)|[\\/]claude(\.m?js)?(\s|$)/.test(cmdline);
  }
  return false;
}

// Walk from startPid up the real process tree; returns the first Claude process.
// argsMap holds command lines for Node processes (needed to recognise npm installs).
function findClaude(table, argsMap, startPid) {
  let cur = table.get(startPid);
  for (let i = 0; cur && i < 16 && cur.pid > 1; i++) {
    if (isClaude(cur, argsMap && argsMap.get(cur.pid))) return cur;
    cur = table.get(cur.ppid);
  }
  return null;
}

function chain(table, startPid) {
  const out = [];
  let cur = table.get(startPid);
  for (let i = 0; cur && i < 16 && cur.pid > 1; i++) { out.push(cur); cur = table.get(cur.ppid); }
  return out;
}
const needsArgs = p => /^(node|nodejs|bun)(\.exe)?$/i.test(path.basename(String(p.comm || '')));

// Run inside the hook (synchronous, ~10–30 ms): ancestors of the hook while the
// intermediate shell still exists. The daemon looks them up later, when the shell
// that ran the hook may already be gone.
function ancestorsSync(startPid) {
  const table = listProcessesSync();
  const list = chain(table, startPid);
  const a = argsSync(list.filter(needsArgs).map(p => p.pid));
  return list.map(p => ({ pid: p.pid, ppid: p.ppid, start: p.start, comm: p.comm, args: a.get(p.pid) || null }));
}

// Same, asynchronous, for the daemon.
function findClaudeAsync(startPid, cb) {
  listProcesses((err, table) => {
    if (err) return cb(err);
    const list = chain(table, startPid);
    args(list.filter(needsArgs).map(p => p.pid), (e, a) => cb(null, findClaude(table, a, startPid), list));
  });
}

function fromAncestors(list) {
  if (!Array.isArray(list)) return null;
  for (const p of list) if (p && isClaude(p, p.args)) return p;
  return null;
}

module.exports = { parseLstart, parseTable, parseArgs, listProcesses, listProcessesSync, startTimes, isClaude, findClaude, findClaudeAsync, ancestorsSync, fromAncestors, chain };
