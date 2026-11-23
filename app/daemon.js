#!/usr/bin/env node
'use strict';
// Jeden proces w tle: rejestr sesji Claude Code + połączenie z Discordem.
// Jedyność instancji zapewnia nazwany potok (drugi proces nie może go utworzyć).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const C = require('./lib/common');
const { findProjectRoot, displayName } = require('./lib/project');
const { SessionUsage, aggregate, countFor } = require('./lib/tokens');
const { DiscordIPC } = require('./lib/discord-ipc');
const pricing = require('./lib/pricing');
const { formatCost } = pricing;
const { DailyUsage } = require('./lib/daily');
const versionLib = require('./lib/version');

// ---------- update check (once a day, anonymous request to the public GitHub API) ----------
let updateInfo = null, updateCheckAt = 0, updateChecking = false;
const PRICES_CACHE = () => path.join(C.P.data, 'state', 'pricing.json');
let pricesCheckAt = 0;
// the price table from the repository (app/pricing.json on main), once a day; validated
// numbers only, never older than the installed table, cached for restarts
function loadCachedPrices() {
  try { if (pricing.setPricing(JSON.parse(fs.readFileSync(PRICES_CACHE(), 'utf8')))) log('price table from cache', pricing.pricesDate()); } catch {}
}
function maybeRefreshPrices() {
  if (!cfg.updatePrices || process.env.CDP_NO_UPDATE_CHECK === '1' || Date.now() - pricesCheckAt < 24 * 3600e3) return;
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.updateRepo || '')) return;
  pricesCheckAt = Date.now();
  versionLib.getJson(`https://raw.githubusercontent.com/${cfg.updateRepo}/main/app/pricing.json`)
    .then(doc => {
      const before = pricing.pricesDate();
      if (pricing.setPricing(doc)) {
        try { C.writeJsonAtomic(PRICES_CACHE(), doc); } catch {}
        if (pricing.pricesDate() !== before) { log('price table updated', before, '->', pricing.pricesDate()); forceScan = true; }
      }
    })
    .catch(e => log('price table refresh failed', e.message));
}
function maybeCheckForUpdate() {
  maybeRefreshPrices();
  maybeAutoUpdate();
  if (!cfg.checkUpdates || process.env.CDP_NO_UPDATE_CHECK === '1' || updateChecking || Date.now() - updateCheckAt < 3600e3) return;
  updateChecking = true; updateCheckAt = Date.now();
  versionLib.checkForUpdate({ repo: cfg.updateRepo, cacheFile: path.join(C.P.data, 'state', 'update-check.json') })
    .then(r => {
      const was = updateInfo && updateInfo.updateAvailable;
      updateInfo = r;
      if (r.updateAvailable && !was) log('update available', r.latest, '(installed', r.installed + ')');
    })
    .catch(e => log('update check failed', e.message))
    .finally(() => { updateChecking = false; });
}
// autoUpdate (opt-in): when the daily check finds a newer release, install it with
// `cli.js update --auto` – only while no session is working, at most once a day per version.
// The installer stops this process; the updater starts the new version again.
const AUTO_FILE = () => path.join(C.P.data, 'state', 'auto-update.json');
let autoUpdating = false;
function maybeAutoUpdate() {
  if (!cfg.autoUpdate || autoUpdating || !updateInfo || !updateInfo.updateAvailable || process.env.CDP_NO_UPDATE_CHECK === '1') return;
  if ([...sessions.values()].some(s => s.status === 'working')) return; // never in the middle of Claude's work
  const last = C.readJson(AUTO_FILE(), {}) || {};
  if (last.version === updateInfo.latest && Date.now() - (last.at || 0) < 24 * 3600e3) return;
  autoUpdating = true;
  try { C.writeJsonAtomic(AUTO_FILE(), { version: updateInfo.latest, at: Date.now() }); } catch {}
  log('auto-update: installing', updateInfo.latest, '(installed', updateInfo.installed + ')');
  const out = fs.openSync(path.join(C.P.logDir, 'auto-update.log'), 'a');
  const child = require('child_process').spawn(process.execPath, [path.join(C.P.app, 'cli.js'), 'update', '--auto'], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: C.P.data });
  child.on('error', e => { log('auto-update failed to start', e.message); autoUpdating = false; });
  child.unref();
  try { fs.closeSync(out); } catch {}
}

const proc = require('./lib/proc');
const { listenExclusive, releaseSocket } = require('./lib/singleton');
const WW = require('./lib/window-watch');
const os = require('os');
const IS_WIN = process.platform === 'win32';
if (!IS_WIN) process.umask(0o077); // registry, status, logs and the socket: owner only

const FAST = process.env.CDP_FAST === '1';
const T = {
  tick: FAST ? 300 : 1000,
  scan: FAST ? 500 : 3000,          // odczyt transkryptów i żywotności procesów
  imageCheck: FAST ? 2000 : (IS_WIN ? 60000 : 15000),  // PID reuse check (tasklist / ps lstart)
  treeRetry: FAST ? 1500 : 30000,    // retry the process-tree lookup for sessions without a PID
  grace: FAST ? 2500 : 20000,       // brak sesji przez tyle ms → koniec procesu
  minGap: FAST ? 300 : 4000,        // minimalny odstęp między SET_ACTIVITY
  window: FAST ? 3000 : 20000, windowMax: 5, // limit Discord RPC: 5 aktualizacji / 20 s
  rotate: FAST ? 1500 : 20000,     // today/session rotation slot
  backoffMin: FAST ? 300 : 2000, backoffMax: FAST ? 3000 : 60000,
};

let cfg = C.loadConfig();
C.setLogMax(cfg.logMaxBytes);
const log = C.log;

// ---------- stan ----------
const sessions = new Map(); // sessionId -> session
const runs = new Map();     // runKey -> { key, start, pid, usages: Map<sid, SessionUsage> }
let noSessionsSince = Date.now();
let lastPayloadJson = null, lastSentAt = 0, sentTimes = [];
let pendingPayload = undefined;
let discord = null, discordState = 'idle', discordError = null, retryDelay = T.backoffMin, nextRetryAt = 0, connecting = false;
let lastImageCheck = 0, lastScan = 0, shuttingDown = false;
let lastPresence = null;
let forceScan = false;
let lastPhase = -1;

// ---------- pomocnicze ----------
function pidAlive(pid) {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function claudeSessionFiles() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(C.P.claudeSessions); } catch { return out; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const j = C.readJson(path.join(C.P.claudeSessions, n), null);
    if (j && j.pid) out.push(j);
  }
  return out;
}

// Ustala PID procesu Claude Code: najpierw rejestr ~/.claude/sessions/<pid>.json,
// potem drzewo procesów od rodzica hooka.
// A resumed conversation runs in a new Claude process with the same session id, while the
// old process's <pid>.json can be left behind (crash, reboot, app restart). Only a live
// process counts; if several are alive, the most recently started one wins.
function resolveFromRegistry(sid) {
  const live = claudeSessionFiles().filter(j => j.sessionId === sid && pidAlive(j.pid) !== false);
  if (!live.length) return null;
  live.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const j = live[0];
  return { pid: j.pid, startedAt: Number.isFinite(j.startedAt) ? j.startedAt : null, entrypoint: j.entrypoint || null, via: 'claude-sessions', procStart: claudeProcStart(j.procStart) };
}

// The session's process is gone: if the same conversation already runs in another live
// Claude process (resume), follow it – a new launch, so a new timer – instead of dropping it.
function rebindOrDrop(s, why) {
  const r = resolveFromRegistry(s.id);
  if (r && r.pid !== s.pid) {
    log('session moved to a new process', s.pid, '->', r.pid, 'session', s.id.slice(0, 8));
    const oldRun = runs.get(s.runKey);
    s.pid = r.pid; s.pidVia = r.via; s.entrypoint = r.entrypoint; s.processStart = r.startedAt;
    s.claudeProcStart = r.procStart; s.procStart = null; s.imageName = null; s.epChecked = false;
    attachRun(s);
    if (oldRun) pruneRun(oldRun);
    forceScan = true;
    return 'moved';
  }
  dropSession(s, why);
  return 'dropped';
}

// Claude Code records its own process start ("procStart": ps-style lstart, seen in UTC).
// Both readings are kept, so the identity check never depends on the time zone.
function claudeProcStart(v) {
  if (typeof v !== 'string') return null;
  const a = [proc.parseLstart(v, true), proc.parseLstart(v, false)].filter(Number.isFinite);
  return a.length ? a : null;
}

let treeLookupBusy = new Set();
function adoptTreePid(s, pid, start, name, via) {
  if (s.pid) return;
  s.pid = pid; s.pidVia = via; s.imageName = name || null;
  if (start) { s.procStart = start; if (!s.processStart) s.processStart = start; }
  attachRun(s); saveRegistry(); log('pid via', via, s.id.slice(0, 8), s.pid);
  forceScan = true;
}

// Fallback when ~/.claude/sessions has no entry for the session: walk the real process
// tree up from the hook's parent to the Claude Code process.
function resolveFromTree(s, ancestors) {
  if (s.pid || treeLookupBusy.has(s.id)) return;
  s.treeTriedAt = Date.now();
  if (!IS_WIN) {
    // 1) ancestors captured by the hook itself (the shell that ran it may be gone now)
    const hit = proc.fromAncestors(ancestors || s.ancestors);
    if (hit) return adoptTreePid(s, hit.pid, hit.start, hit.comm, 'process-tree');
    if (!s.hookPpid) return;
    // 2) ps from the hook's parent, if it still exists
    treeLookupBusy.add(s.id);
    proc.findClaudeAsync(s.hookPpid, (err, c) => {
      treeLookupBusy.delete(s.id);
      if (err) { log('tree lookup failed', err.message); return; }
      if (c) adoptTreePid(s, c.pid, c.start, c.comm, 'process-tree');
    });
    return;
  }
  if (!s.hookPpid) return;
  treeLookupBusy.add(s.id);
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, maxBuffer: 64 << 20 }, (err, stdout) => {
    treeLookupBusy.delete(s.id);
    if (err) { log('tree lookup failed', err.message); return; }
    let list; try { list = JSON.parse(stdout); } catch { return; }
    const byPid = new Map(list.map(p => [p.ProcessId, p]));
    let cur = byPid.get(s.hookPpid);
    for (let i = 0; cur && i < 12; i++) {
      const name = String(cur.Name || '').toLowerCase();
      const cl = String(cur.CommandLine || '').toLowerCase();
      if (name === 'claude.exe' || name === 'claude' || (name === 'node.exe' && /claude-code|[\\/]claude(\.js)?\b/.test(cl) && !/discord-presence/.test(cl))) {
        adoptTreePid(s, cur.ProcessId, cur.Created ? Date.parse(cur.Created) || null : null, cur.Name, 'process-tree');
        return;
      }
      cur = byPid.get(cur.ParentProcessId);
    }
  });
}

function attachRun(s) {
  const key = s.pid ? `pid:${s.pid}` : `sid:${s.id}`;
  if (s.runKey && s.runKey !== key) {
    const old = runs.get(s.runKey);
    if (old) { old.usages.delete(s.id); if (!old.usages.size) runs.delete(s.runKey); }
  }
  let run = runs.get(key);
  if (!run) {
    run = { key, pid: s.pid || null, start: s.processStart || s.firstSeen || Date.now(), usages: new Map() };
    runs.set(key, run);
  } else if (s.processStart && s.processStart < run.start) run.start = s.processStart;
  s.runKey = key;
  if (s.transcriptPath && !run.usages.has(s.id)) {
    run.usages.set(s.id, new SessionUsage(s.transcriptPath, s.id, { includeSubagents: cfg.includeSubagents }));
  }
  return run;
}

// ---------- rejestr (przetrwa restart demona) ----------
function saveRegistry() {
  const data = {
    sessions: [...sessions.values()].map(s => ({
      id: s.id, pid: s.pid, pidVia: s.pidVia, imageName: s.imageName || null, transcriptPath: s.transcriptPath, cwd: s.cwd,
      projectRoot: s.projectRoot, lastActivity: s.lastActivity, firstSeen: s.firstSeen, processStart: s.processStart, procStart: s.procStart || null, claudeProcStart: s.claudeProcStart || null, hookPpid: s.hookPpid, entrypoint: s.entrypoint || null, status: s.status || null, statusSince: s.statusSince || null, activity: s.activity || null, activityAt: s.activityAt || null, promptId: s.promptId || null, endedPromptId: s.endedPromptId || null,
    })),
    runs: [...runs.values()].map(r => ({ key: r.key, start: r.start, sids: [...r.usages.keys()] })),
  };
  try { C.writeJsonAtomic(C.P.registry, data); } catch (e) { log('registry save', e.message); }
}

function loadRegistry() {
  const data = C.readJson(C.P.registry, null);
  if (!data) return;
  const runStarts = new Map((data.runs || []).map(r => [r.key, r.start]));
  for (const r of data.sessions || []) {
    const s = { ...r, ended: false };
    sessions.set(s.id, s);
    const run = attachRun(s);
    if (runStarts.has(run.key)) run.start = runStarts.get(run.key);
  }
  // przebiegi z sesjami zakończonymi przez /clear (ten sam proces)
  for (const r of data.runs || []) {
    const run = runs.get(r.key);
    if (!run) continue;
    for (const sid of r.sids || []) if (!run.usages.has(sid)) {
      const known = (data.sessions || []).find(x => x.id === sid);
      if (known && known.transcriptPath) run.usages.set(sid, new SessionUsage(known.transcriptPath, sid, { includeSubagents: cfg.includeSubagents }));
    }
  }
  if (sessions.size) log('registry restored', sessions.size, 'sessions');
}

// ---------- zdarzenia z hooków ----------
function handleEvent(ev) {
  if (!ev || !ev.sessionId) return;
  const sid = ev.sessionId;
  if (ev.event === 'SessionEnd') {
    const s = sessions.get(sid);
    if (s) {
      sessions.delete(sid);
      log('session end', sid.slice(0, 8), ev.reason);
      // Przy /clear ten sam proces kontynuuje – zużycie zostaje w przebiegu (run).
      const run = runs.get(s.runKey);
      const procAlive = s.pid && pidAlive(s.pid);
      if (run && !(ev.reason === 'clear' && procAlive)) pruneRun(run);
    }
    return;
  }
  let s = sessions.get(sid);
  const isNew = !s;
  if (!s) {
    s = { id: sid, pid: null, transcriptPath: null, cwd: null, projectRoot: null, lastActivity: 0, firstSeen: ev.at || Date.now(), processStart: null, hookPpid: null };
    sessions.set(sid, s);
  }
  if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;
  if (ev.cwd) s.cwd = ev.cwd;
  if (ev.projectRoot) s.projectRoot = ev.projectRoot;
  else if (ev.cwd) { const r = findProjectRoot(ev.cwd); s.projectRoot = r && r.root; }
  if (ev.hookPpid) s.hookPpid = ev.hookPpid;
  if (Array.isArray(ev.ancestors) && ev.ancestors.length) s.ancestors = ev.ancestors.slice(0, 16);
  // aktywność użytkownika: start sesji i wysłanie promptu (nie statusLine, nie zmiana katalogu)
  if (ev.event === 'SessionStart' || ev.event === 'UserPromptSubmit') s.lastActivity = Math.max(s.lastActivity, ev.at || Date.now());
  // Claude's state: working after a prompt, waiting for you after the reply / a notification
  if (ev.event === 'UserPromptSubmit') {
    s.status = 'working'; s.statusSince = ev.at || Date.now(); s.activity = 'thinking'; s.activityAt = s.statusSince;
    s.promptId = ev.promptId || null;
  }
  else if (ev.event === 'PreToolUse') {
    // PreToolUse is async: it can arrive after the turn's Stop, and its `at` is taken late
    // (after reading stdin), so time stamps cannot order it. The prompt id can:
    //  - working: update the activity unless the event belongs to an older prompt
    //  - waiting: reopen only for a prompt that has not ended (e.g. Claude continuing on its
    //    own with a new prompt id, or after a permission prompt); a late hook of the ended
    //    turn – or one without a prompt id (older Claude Code) – never reopens it
    const at = ev.at || Date.now();
    const pid = ev.promptId || null;
    if (s.status === 'working') {
      if (ev.tool && !(pid && s.promptId && pid !== s.promptId)) { s.activity = ev.tool; s.activityAt = at; }
    } else if (pid && pid !== s.endedPromptId) {
      s.status = 'working'; s.statusSince = at; s.promptId = pid;
      if (ev.tool) { s.activity = ev.tool; s.activityAt = at; }
    }
  }
  else if (['Stop', 'StopFailure', 'Notification', 'SessionStart'].includes(ev.event)) {
    s.status = 'waiting'; s.statusSince = ev.at || Date.now(); s.activity = null;
    // the turn is over (a Notification only pauses it, e.g. for a permission prompt)
    if (ev.event === 'Stop' || ev.event === 'StopFailure') s.endedPromptId = ev.promptId || s.promptId || null;
  }
  if (!s.pid) {
    const r = resolveFromRegistry(sid);
    if (r) { s.pid = r.pid; s.pidVia = r.via; s.processStart = r.startedAt; s.entrypoint = r.entrypoint; s.claudeProcStart = r.procStart; }
  }
  attachRun(s);
  if (!s.pid) resolveFromTree(s, ev.ancestors);
  if (isNew) log('session', ev.event, sid.slice(0, 8), 'pid', s.pid || '?', 'via', s.pidVia || '-', ev.source || '');
}

function pruneRun(run) {
  for (const s of sessions.values()) if (s.runKey === run.key) return;
  runs.delete(run.key);
}

function processInbox() {
  let names = [];
  try { names = fs.readdirSync(C.P.inbox).filter(n => n.endsWith('.json')).sort(); } catch { return false; }
  if (!names.length) return false;
  for (const n of names) {
    const f = path.join(C.P.inbox, n);
    const ev = C.readJson(f, null);
    try { fs.unlinkSync(f); } catch {}
    try { handleEvent(ev); } catch (e) { log('event error', e); }
  }
  // stare pliki .tmp po przerwanych hookach
  try {
    for (const n of fs.readdirSync(C.P.inbox)) if (n.endsWith('.tmp')) {
      const f = path.join(C.P.inbox, n);
      if (Date.now() - fs.statSync(f).mtimeMs > 60000) fs.unlinkSync(f);
    }
  } catch {}
  saveRegistry();
  return true;
}

// ---------- żywotność ----------
function checkLiveness() {
  let changed = false;
  for (const s of [...sessions.values()]) {
    if (!s.pid) {
      const r = resolveFromRegistry(s.id);
      if (r) { s.pid = r.pid; s.pidVia = r.via; s.entrypoint = r.entrypoint; s.processStart = s.processStart || r.startedAt; s.claudeProcStart = r.procStart; attachRun(s); changed = true; }
      else if (Date.now() - (s.treeTriedAt || 0) > T.treeRetry) resolveFromTree(s);
      continue; // bez PID nie da się wykryć awarii – czekamy na SessionEnd
    }
    if (!s.epChecked) {
      s.epChecked = true;
      const j = C.readJson(path.join(C.P.claudeSessions, `${s.pid}.json`), null);
      s.entrypoint = j && j.pid === s.pid ? (j.entrypoint || null) : null; changed = true;
    }
    if (pidAlive(s.pid) === false) { rebindOrDrop(s, 'process gone'); changed = true; }
  }
  if (Date.now() - lastImageCheck > T.imageCheck && sessions.size) {
    lastImageCheck = Date.now();
    if (IS_WIN) checkImagesWindows(); else checkStartTimesUnix();
  }
  if (changed) saveRegistry();
}

function dropSession(s, why) {
  log(why, s.pid, 'session', s.id.slice(0, 8));
  sessions.delete(s.id);
  const run = runs.get(s.runKey); if (run) pruneRun(run);
  forceScan = true;
}

function checkImagesWindows() {
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000, maxBuffer: 16 << 20 }, (err, out) => {
    if (err) return;
    const names = new Map();
    for (const line of out.split(/\r?\n/)) { const m = /^"([^"]+)","(\d+)"/.exec(line); if (m) names.set(+m[2], m[1]); }
    for (const s of [...sessions.values()]) {
      if (!s.pid) continue;
      const nm = names.get(s.pid);
      if (!nm) continue;
      if (!s.imageName) { s.imageName = nm; continue; }
      if (nm.toLowerCase() !== s.imageName.toLowerCase()) dropSession(s, `pid reused (${s.imageName} -> ${nm})`);
    }
  });
}

// macOS/Linux: the start time identifies the process. A PID whose process started later
// than the one we know (or later than Claude's own startedAt) was reused by another program.
function checkStartTimesUnix() {
  const list = [...sessions.values()].filter(s => s.pid);
  if (!list.length) return;
  // the PID each session had when ps was asked: by the time the asynchronous result arrives
  // a session may have moved to a new process (resume) – its result then says nothing about it
  const queried = new Map(list.map(s => [s, s.pid]));
  proc.startTimes([...new Set(list.map(s => s.pid))], (err, starts) => {
    if (err) { log('ps check failed', err.message); return; }
    let changed = false;
    for (const s of list) {
      if (sessions.get(s.id) !== s || s.pid !== queried.get(s)) continue; // dropped, replaced or rebound meanwhile
      const st = starts.get(s.pid);
      if (st === undefined) { rebindOrDrop(s, 'process gone'); changed = true; continue; }
      if (st === null) continue;
      if (s.procStart) {
        if (Math.abs(st - s.procStart) > 1500) { dropSession(s, 'pid reused (start time changed)'); changed = true; }
        continue;
      }
      // first observation: compare with the start time Claude Code recorded for its PID
      if (Array.isArray(s.claudeProcStart) && !s.claudeProcStart.some(t => Math.abs(st - t) <= 1500)) { dropSession(s, 'pid reused (start time differs from Claude\'s record)'); changed = true; continue; }
      s.procStart = st; changed = true;
    }
    if (changed) saveRegistry();
  });
}

// ---------- prezentacja ----------
// ---------- widoczność okna aplikacji Claude desktop ----------
// Sesje aplikacji desktop (entrypoint "claude-desktop") działają dalej po zamknięciu
// okna (aplikacja zostaje w zasobniku). Taka sesja jest ukrywana, gdy proces-rodzic
// (aplikacja Claude) nie ma widocznego okna. Okno zminimalizowane = nadal widoczne.
let windowVis = {};           // pid sesji -> true/false
let appState = { visible: false, mode: 'unknown' }; // Claude desktop app: window visible? which tab?
let macInfo = null;           // macOS: { state, mode, accessibility } from the watcher
let chatSince = null;         // when the regular Claude chat tab became the shown tab
function isChat() { return !!cfg.showChat && appState.visible && appState.mode === 'chat'; }
function applyWatch(v) {
  if (v && typeof v === 'object' && (v.vis || v.app)) { windowVis = v.vis || {}; appState = { visible: !!(v.app && v.app.visible), mode: (v.app && v.app.mode) || 'unknown' }; macInfo = v.mac || null; }
  else { windowVis = v || {}; appState = { visible: false, mode: 'unknown' }; macInfo = null; }
}
function windowedPids() { return [...sessions.values()].filter(isWindowed).map(s => s.pid); }
let watcher = null, watcherPids = '', watcherRestartAt = 0, watcherFails = 0;
const WATCH_PIDS = path.join(C.P.data, 'state', 'window-pids.txt');

function isWindowed(s) { return cfg.hideWhenWindowClosed && s.entrypoint === 'claude-desktop' && !!s.pid; }
function isHidden(s) { return isWindowed(s) && windowVis[String(s.pid)] === false; }

function updateWindowWatch() {
  if (process.env.CDP_WINDOW_STATE_FILE) {
    const v = C.readJson(process.env.CDP_WINDOW_STATE_FILE, {}) || {};
    applyWatch(v && v.mac_raw ? WW.fromMac(v.mac_raw, windowedPids()) : v); // mac_raw: test input in the macOS watcher's format
    return;
  }
  const pids = windowedPids().sort((a, b) => a - b).join(',');
  if (pids !== watcherPids) { try { C.ensureDir(path.dirname(WATCH_PIDS)); fs.writeFileSync(WATCH_PIDS, pids); } catch {} watcherPids = pids; }
  const platform = process.platform;
  // macOS: the Code/chat tab is only known with Accessibility, so the chat card alone
  // does not need a watcher without it
  const wantChat = cfg.showChat && (platform === 'win32' || (platform === 'darwin' && cfg.macAccessibility));
  const spec = WW.watcherCommand({ platform, appDir: C.P.app, daemonPid: process.pid, pidFile: WATCH_PIDS, macAccessibility: !!cfg.macAccessibility });
  const sig = spec ? JSON.stringify(spec.args) : '';
  if (watcher && watcher.sig !== sig) { try { watcher.kill(); } catch {} watcher = null; watcherFails = 0; watcherRestartAt = 0; }
  if (!spec) { applyWatch({}); return; }
  if (!pids && !wantChat) { if (watcher) { try { watcher.kill(); } catch {} watcher = null; } applyWatch({}); return; }
  if (watcher || Date.now() < watcherRestartAt) return;
  const { spawn } = require('child_process');
  let w;
  try { w = spawn(spec.cmd, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { log('window watcher spawn failed', e.message); watcherRestartAt = Date.now() + 60000; return; }
  w.sig = sig;
  watcher = w;
  let buf = '';
  w.stdout.setEncoding('utf8');
  w.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      try {
        let v = JSON.parse(line);
        if (platform === 'darwin') v = WW.fromMac(v, windowedPids());
        const before = JSON.stringify([windowVis, appState, macInfo]);
        applyWatch(v); watcherFails = 0;
        if (JSON.stringify([windowVis, appState, macInfo]) !== before) { log('window state', JSON.stringify(v.mac || v)); forceScan = true; setImmediate(tick); }
      } catch {}
    }
  });
  w.on('error', e => log('window watcher error', e.message));
  w.on('exit', code => {
    if (watcher === w) watcher = null;
    if (shuttingDown) return;
    watcherFails++; watcherRestartAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(watcherFails, 5));
    applyWatch({}); // bez obserwatora nie ukrywamy (bezpieczny domyślny stan)
    log('window watcher exited', code);
  });
}

function activeSession() {
  let best = null;
  for (const s of sessions.values()) if (isHidden(s)) continue; else if (!best || s.lastActivity > best.lastActivity || (s.lastActivity === best.lastActivity && s.firstSeen > best.firstSeen)) best = s;
  return best;
}

function chatPresence() {
  const L = C.strings(cfg.language);
  const activity = { details: L.chat, timestamps: { start: Math.floor(chatSince || Date.now()) } };
  if (ACT_TYPES[cfg.activityType]) activity.type = ACT_TYPES[cfg.activityType];
  const img = largeImage();
  if (img) activity.assets = { large_image: img, large_text: 'Claude' };
  const promo = promoButton(L);
  if (promo) activity.buttons = [promo];
  return { activity, debug: { mode: 'chat', chatSince: new Date(chatSince || Date.now()).toISOString(), note: 'regular Claude chat: no local token data' } };
}

// ---------- helpers for the card ----------
const ACT_TYPES = { playing: 0, listening: 2, watching: 3, competing: 5 };
const WORKING_STALE_MS = 15 * 60000; // no Stop hook and no new reply for this long → treat as waiting
function modelName(id) {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(String(id || ''));
  if (!m) return id || null;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}
function assetUrl(name) {
  const base = String(cfg.assetBaseUrl || '').replace(/\/+$/, '');
  return /^https:\/\//.test(base) ? `${base}/${name}` : null;
}
function sessionStatus(s, su) {
  let st = s.status || 'waiting';
  if (st === 'working' && su) {
    if (su.lastInterruptTs > (s.statusSince || 0)) st = 'waiting';               // Esc – no Stop hook
    else if (Date.now() - Math.max(s.statusSince || 0, su.lastAssistantTs || 0) > WORKING_STALE_MS) st = 'waiting';
  }
  return st;
}
function projectLink(projectRoot) {
  if (!projectRoot) return null;
  const base = path.basename(projectRoot).toLowerCase();
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  for (const [k, v] of Object.entries(cfg.links || {})) {
    if (typeof v !== 'string' || !/^https:\/\/[^\s]+$/.test(v)) continue;
    if (k.toLowerCase() === base || ((k.includes('/') || k.includes('\\')) && norm(k) === norm(projectRoot))) return v;
  }
  return null;
}
let daily = null;
function todayTotals() {
  if (!cfg.showToday || cfg.showToday === 'off') return null;
  if (!daily) daily = new DailyUsage(process.env.CDP_PROJECTS_DIR || path.join(path.dirname(C.P.claudeSessions), 'projects'), { includeSubagents: cfg.includeSubagents });
  try { return daily.totals(cfg.pricing); } catch (e) { log('daily', e.message); return null; }
}
function rotationPhase() { return Math.floor(Date.now() / T.rotate) % 2; }

function isPaused() {
  const u = Number(cfg.pausedUntil) || 0;
  return u === -1 || u > Date.now();
}
function promoButton(L) {
  // "Get this plugin" – lets people who see the card find the project (promoButton: false hides it)
  return cfg.promoButton && /^[\w.-]+\/[\w.-]+$/.test(cfg.updateRepo || '') ? { label: L.promoButton, url: `https://github.com/${cfg.updateRepo}` } : null;
}

function computePresence() {
  if (isPaused()) return null;
  if (isChat()) { if (!chatSince) chatSince = Date.now(); return chatPresence(); }
  chatSince = null;
  const s = activeSession();
  if (!s) return null;
  const run = runs.get(s.runKey) || attachRun(s);
  const usages = [...run.usages.values()];
  for (const u of usages) { try { u.poll(); } catch (e) { log('poll', e.message); } }
  const su = run.usages.get(s.id) || null;
  const hasSource = usages.some(u => u.hasSource);
  const agg = aggregate(usages, run.start, cfg.pricing);
  const scopeTotals = cfg.tokenScope === 'conversation' ? agg.conversation : agg.sinceLaunch;
  const value = hasSource ? countFor(scopeTotals, cfg.tokenCount) : null;
  const name = displayName(s.projectRoot, cfg);
  const L = C.strings(cfg.language);
  const fmt = C.formatTokens(value, cfg.language);
  const label = cfg.tokenScope === 'conversation' ? L.convTokens : L.sessionTokens;
  const cost = hasSource && cfg.showCost && scopeTotals.messages > scopeTotals.unpricedMessages ? formatCost(scopeTotals.costUsd, cfg.language) : null;
  const costPart = cost ? ` · ~${cost}${scopeTotals.unpricedMessages ? '+' : ''}` : '';
  let status = sessionStatus(s, su);
  const awayMs = (Number(cfg.awayAfterMinutes) || 0) * 60000;
  if (status === 'waiting' && awayMs > 0 && Date.now() - (s.statusSince || s.firstSeen || Date.now()) >= awayMs) status = 'away';
  // what Claude is doing (Editing files, Running commands…) instead of a plain "Working"
  const act = status === 'working' && cfg.showActivity !== false && s.activity && L.activity[s.activity] ? s.activity : null;
  const workingText = act ? L.activity[act] : L.working;
  let state;
  if (fmt === null) state = L.noData;
  else if (cfg.showStatus) state = `${status === 'working' ? workingText : status === 'away' ? L.away : L.waiting} · ${fmt} ${L.tokensWord}${costPart}`;
  else state = `${label}: ${fmt}${costPart}`;
  if (cfg.showSessionCount && sessions.size > 1) state += ` · ${sessions.size} ${L.sessions}`;
  // today's totals: every other rotation slot replaces the state line, or only the tooltip
  const today = todayTotals();
  let todayText = null;
  if (today && today.messages) {
    const tc = cfg.showCost && today.messages > today.unpricedMessages ? ` · ~${formatCost(today.costUsd, cfg.language)}` : '';
    todayText = `${L.today}: ${C.formatTokens(countFor(today, cfg.tokenCount), cfg.language)} ${L.tokensWord}${tc}`;
    if (cfg.showToday === 'rotate' && rotationPhase() === 1) state = todayText;
  }
  const activity = {
    details: name ? `${L.project}: ${name}` : L.hidden,
    state,
    timestamps: { start: Math.floor(run.start) },
  };
  // Discord shows only one "Playing" (type 0) activity at a time; another type lets it
  // appear next to e.g. the VS Code extension. RPC accepts 0, 2, 3, 5.
  if (cfg.activityType && ACT_TYPES[cfg.activityType]) activity.type = ACT_TYPES[cfg.activityType];
  // big icon tooltip: model and effort (+ today's totals when not rotating)
  const tip = [];
  if (cfg.showModel && su && su.lastModel) tip.push(modelName(su.lastModel) + (su.lastEffort ? ` · ${su.lastEffort} ${L.effort}` : ''));
  if (todayText && cfg.showToday === 'tooltip') tip.push(todayText);
  const largeText = (tip.join(' · ') || cfg.largeImageText || 'Claude Code').slice(0, 128);
  const img = largeImage();
  const assets = {};
  if (img) { assets.large_image = img; assets.large_text = largeText.length >= 2 ? largeText : 'Claude Code'; }
  if (cfg.showStatus) {
    const icon = assetUrl(status === 'working' ? 'status-working.png' : 'status-waiting.png');
    if (icon && img) { assets.small_image = icon; assets.small_text = status === 'working' ? (act ? `Claude: ${L.activity[act].toLowerCase()}…` : L.workingLong) : status === 'away' ? L.awayLong : L.waitingLong; }
  }
  if (Object.keys(assets).length) activity.assets = assets;
  const link = name ? projectLink(s.projectRoot) : null; // never for hidden projects
  const buttons = [];
  if (link) buttons.push({ label: /^https:\/\/github\.com\//i.test(link) ? L.githubButton : L.openButton, url: link });
  const promo = promoButton(L);
  if (promo && !(link && link.replace(/\/+$/, '').toLowerCase() === promo.url.toLowerCase())) buttons.push(promo);
  if (buttons.length) activity.buttons = buttons.slice(0, 2);
  return {
    activity,
    debug: {
      sessionId: s.id, pid: s.pid, pidVia: s.pidVia || null, runStart: new Date(run.start).toISOString(),
      claudeState: status, activity: act, model: su && su.lastModel, effort: su && su.lastEffort, today, link,
      tokenSource: {
        kind: 'transcript-jsonl',
        files: usages.flatMap(u => [...u.tails.values()].map(t => ({ file: t.file, kind: t.kind, exists: t.exists, lines: t.lines, badLines: t.badLines, bytesRead: t.offset }))),
        uniqueMessages: usages.reduce((a, u) => a + u.messages.size, 0),
        duplicateLinesCollapsed: usages.reduce((a, u) => a + u.duplicateLines, 0),
        compactBoundariesSeen: usages.reduce((a, u) => a + u.compactions, 0),
        mode: cfg.tokenCount, scope: cfg.tokenScope, includeSubagents: cfg.includeSubagents,
        sinceLaunch: agg.sinceLaunch, conversationTotal: agg.conversation, published: value,
        cost: { published: cost, pricesDate: pricing.pricesDate(), basis: 'Anthropic API list prices; subscriptions are not billed per token' },
      },
    },
  };
}

// ---------- large image ----------
// largeImageKey: "" (default) = the application's own icon from the Developer Portal
// (General Information → App Icon), looked up once via Discord's public application
// endpoint and sent as an image URL; "<key>" = a Rich Presence Art Asset; "none" = no image.
let appIcon = { forId: null, url: null, nextTry: 0 };
function largeImage() {
  const k = (cfg.largeImageKey || '').trim();
  if (k.toLowerCase() === 'none') return null;
  if (k) return k;
  if (!cfg.applicationId) return null;
  if (appIcon.forId === cfg.applicationId) return appIcon.url;
  if (Date.now() >= appIcon.nextTry) fetchAppIcon(cfg.applicationId);
  return null;
}
function fetchAppIcon(id) {
  appIcon.nextTry = Date.now() + 10 * 60000;
  const https = require('https');
  const req = https.get(`https://discord.com/api/v10/applications/${id}/rpc`, { timeout: 8000, headers: { 'User-Agent': 'claude-code-discord-presence' } }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => { body += d; });
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
        const j = JSON.parse(body);
        appIcon = { forId: id, url: j.icon ? `https://cdn.discordapp.com/app-icons/${id}/${j.icon}.png?size=512` : null, nextTry: 0 };
        log('app icon', j.icon ? 'found' : 'not set');
        lastPayloadJson = null; forceScan = true;
      } catch (e) { log('app icon lookup failed', e.message); }
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', e => log('app icon lookup failed', e.message));
}

// ---------- Discord ----------
function scheduleRetry(err) {
  discordError = err ? String(err.message || err) : null;
  discordState = 'waiting';
  nextRetryAt = Date.now() + retryDelay;
  retryDelay = Math.min(retryDelay * 2, T.backoffMax);
}

async function ensureDiscord() {
  if (!cfg.applicationId) { discordState = 'no-application-id'; return; }
  if (discord && discord.ready) return;
  if (connecting || Date.now() < nextRetryAt) return;
  connecting = true; discordState = 'connecting';
  const d = new DiscordIPC(cfg.applicationId);
  d.on('error', e => log('discord error', e.message));
  try {
    await d.connect();
    discord = d; discordState = 'connected'; discordError = null; retryDelay = T.backoffMin;
    // after a (re)connect: send the activity again (same start time) – or, when there is none
    // (paused, no session), an explicit clear on the new connection
    lastPayloadJson = '(reconnected)'; pendingPayload = undefined;
    log('discord connected');
    d.on('disconnected', () => { log('discord disconnected'); discord = null; scheduleRetry(new Error('disconnected')); });
    d.on('closeFrame', e => log('discord close frame', e.message));
  } catch (e) {
    if (discordState !== 'waiting' || discordError !== e.message) log('discord connect failed:', e.message);
    scheduleRetry(e);
  } finally { connecting = false; }
}

async function pushPresence(payload) {
  const json = JSON.stringify(payload);
  if (json === lastPayloadJson) { pendingPayload = undefined; return; }
  pendingPayload = payload;
  if (!discord || !discord.ready) return;
  const now = Date.now();
  sentTimes = sentTimes.filter(t => now - t < T.window);
  if (now - lastSentAt < T.minGap || sentTimes.length >= T.windowMax) return; // spróbujemy przy kolejnym takcie
  lastSentAt = now; sentTimes.push(now);
  try {
    await discord.setActivity(payload, process.pid);
    lastPayloadJson = json; pendingPayload = undefined;
  } catch (e) { log('SET_ACTIVITY failed', e.message); }
}

// ---------- status dla trybu diagnostycznego ----------
function writeStatus(p) {
  const st = {
    updatedAt: new Date().toISOString(), daemonPid: process.pid,
    config: { enabled: cfg.enabled, applicationIdSet: !!cfg.applicationId, applicationIdIsDefault: cfg.applicationIdIsDefault, tokenCount: cfg.tokenCount, tokenScope: cfg.tokenScope, hideProject: cfg.hideProject },
    discord: { state: discordState, error: discordError, nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null, lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null },
    activityPayload: p ? p.activity : null,
    version: versionLib.installedVersion(), update: updateInfo, pricesDate: pricing.pricesDate(),
    paused: isPaused() ? (Number(cfg.pausedUntil) === -1 ? 'until resume' : new Date(Number(cfg.pausedUntil)).toISOString()) : null,
    claudeApp: { windowVisible: appState.visible, tab: appState.mode, showingChat: isChat(), platform: process.platform, ...(macInfo ? { mac: macInfo } : process.platform === 'darwin' ? { mac: { state: 'not watched', accessibility: cfg.macAccessibility ? 'requested' : 'off' } } : {}) },
    sentToDiscord: lastPayloadJson ? JSON.parse(lastPayloadJson) : null,
    active: p ? p.debug : null,
    sessions: [...sessions.values()].map(s => ({ id: s.id, pid: s.pid, pidVia: s.pidVia || null, project: displayName(s.projectRoot, cfg), projectRoot: s.projectRoot, lastActivity: s.lastActivity ? new Date(s.lastActivity).toISOString() : null, run: s.runKey, window: isWindowed(s) ? (windowVis[String(s.pid)] === false ? 'closed' : windowVis[String(s.pid)] === true ? 'open' : 'unknown') : null })),
  };
  try { C.writeJsonAtomic(C.P.status, st); } catch {}
}

// ---------- pętla ----------
async function tick() {
  if (shuttingDown) return;
  try {
    // a config.json caught mid-write (or broken by hand) must not flip everything to the
    // defaults for a tick – keep the last good configuration until it parses again
    if (!C.configReadable()) return;
    const newCfg = C.loadConfig();
    if (JSON.stringify(newCfg) !== JSON.stringify(cfg)) {
      const appChanged = newCfg.applicationId !== cfg.applicationId;
      // resend (or clear, e.g. after `pause`) – null would mean "nothing is shown" and skip the clear
      cfg = newCfg; C.setLogMax(cfg.logMaxBytes); lastPayloadJson = '(config changed)';
      if (appChanged && discord) { try { discord.close(); } catch {} discord = null; nextRetryAt = 0; retryDelay = T.backoffMin; }
      log('config reloaded');
    }
    if (!cfg.enabled) return shutdown('integration disabled');
    maybeCheckForUpdate();

    const gotEvents = processInbox();
    if (rotationPhase() !== lastPhase) { lastPhase = rotationPhase(); forceScan = true; }
    if (gotEvents || forceScan || Date.now() - lastScan >= T.scan) {
      lastScan = Date.now(); forceScan = false;
      checkLiveness();
      updateWindowWatch();
      lastPresence = computePresence();
      writeStatus(lastPresence);
    }

    if (!sessions.size && !isChat()) {
      if (!cfg.autostart && Date.now() - noSessionsSince > T.grace) return shutdown('no open sessions');
    } else noSessionsSince = Date.now();

    await ensureDiscord();
    if (lastPresence) await pushPresence(lastPresence.activity);
    else if (pendingPayload !== undefined || lastPayloadJson !== null) {
      if (discord && discord.ready) { try { await discord.setActivity(null); lastPayloadJson = null; pendingPayload = undefined; } catch {} }
    }
  } catch (e) { log('tick error', e); }
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown:', reason);
  try { if (discord && discord.ready) await Promise.race([discord.setActivity(null), new Promise(r => setTimeout(r, 1500))]); } catch {}
  try { discord && discord.close(); } catch {}
  try { watcher && watcher.kill(); } catch {}
  if (!sessions.size) { try { fs.rmSync(C.P.registry, { force: true }); } catch {} }
  else saveRegistry();
  try { C.writeJsonAtomic(C.P.status, { updatedAt: new Date().toISOString(), daemonPid: null, stopped: reason }); } catch {}
  try { server.close(); } catch {}
  releaseSocket(listenAddr, listenIno);
  setTimeout(() => process.exit(0), 300);
}

// ---------- start: blokada jednej instancji ----------
const server = net.createServer(sock => {
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', d => {
    buf += d;
    if (!buf.includes('\n')) return;
    const cmd = buf.trim(); buf = '';
    if (cmd === 'nudge') { sock.end('ok\n'); setImmediate(tick); }
    else if (cmd === 'ping') sock.end('pong\n');
    else if (cmd === 'stop') { sock.end('stopping\n'); shutdown('stop command'); }
    else sock.end('?\n');
  });
  sock.on('error', () => {});
});

let listenAddr = null, listenIno = null;
async function main() {
  if (!cfg.enabled) process.exit(0);
  C.ensurePrivateDirs();
  const addr = C.pipeName();
  let res;
  try { res = await listenExclusive(server, addr, { log }); } catch (e) { log('cannot listen on', addr, e.message); process.exit(1); }
  if (!res.ok) { if (res.reason !== 'running') log('not starting:', res.reason); process.exit(0); } // another process already runs
  listenAddr = addr; listenIno = res.ino == null ? null : res.ino;
  server.on('error', e => log('server error', e));
  log('daemon started', process.version, process.platform, process.arch, 'appId', cfg.applicationIdIsDefault ? 'built-in' : 'custom', process.argv.includes('--standby') ? '(standby)' : '');
  loadRegistry();
  loadCachedPrices();
  noSessionsSince = Date.now();
  setInterval(tick, T.tick);
  tick();
}

process.on('uncaughtException', e => { log('uncaught', e); });
process.on('unhandledRejection', e => { log('unhandled', e); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));

main();
