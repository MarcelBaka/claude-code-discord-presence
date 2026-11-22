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
const { formatCost, PRICES_DATE } = require('./lib/pricing');

const FAST = process.env.CDP_FAST === '1';
const T = {
  tick: FAST ? 300 : 1000,
  scan: FAST ? 500 : 3000,          // odczyt transkryptów i żywotności procesów
  imageCheck: FAST ? 2000 : 60000,  // kontrola ponownego użycia PID
  grace: FAST ? 2500 : 20000,       // brak sesji przez tyle ms → koniec procesu
  minGap: FAST ? 300 : 4000,        // minimalny odstęp między SET_ACTIVITY
  window: FAST ? 3000 : 20000, windowMax: 5, // limit Discord RPC: 5 aktualizacji / 20 s
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
function resolveFromRegistry(sid) {
  for (const j of claudeSessionFiles()) if (j.sessionId === sid) return { pid: j.pid, startedAt: j.startedAt || null, entrypoint: j.entrypoint || null, via: 'claude-sessions' };
  return null;
}

let treeLookupBusy = new Set();
function resolveFromTree(s) {
  if (process.platform !== 'win32' || !s.hookPpid || treeLookupBusy.has(s.id)) return;
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
      if (name === 'claude.exe' || name === 'claude' || (name === 'node.exe' && /claude-code|[\\/]claude(\.js)?\b/.test(cl))) {
        if (!s.pid) {
          s.pid = cur.ProcessId; s.pidVia = 'process-tree'; s.imageName = cur.Name;
          if (!s.runStartFixed && cur.Created) { s.processStart = Date.parse(cur.Created) || null; }
          attachRun(s); saveRegistry(); log('pid via tree', s.id.slice(0, 8), s.pid);
        }
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
      projectRoot: s.projectRoot, lastActivity: s.lastActivity, firstSeen: s.firstSeen, processStart: s.processStart, hookPpid: s.hookPpid, entrypoint: s.entrypoint || null,
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
  // aktywność użytkownika: start sesji i wysłanie promptu (nie statusLine, nie zmiana katalogu)
  if (ev.event === 'SessionStart' || ev.event === 'UserPromptSubmit') s.lastActivity = Math.max(s.lastActivity, ev.at || Date.now());
  if (!s.pid) {
    const r = resolveFromRegistry(sid);
    if (r) { s.pid = r.pid; s.pidVia = r.via; s.processStart = r.startedAt; s.entrypoint = r.entrypoint; }
  }
  attachRun(s);
  if (!s.pid) resolveFromTree(s);
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
      if (r) { s.pid = r.pid; s.pidVia = r.via; s.entrypoint = r.entrypoint; s.processStart = s.processStart || r.startedAt; attachRun(s); changed = true; }
      continue; // bez PID nie da się wykryć awarii – czekamy na SessionEnd
    }
    if (!s.epChecked) {
      s.epChecked = true;
      const j = C.readJson(path.join(C.P.claudeSessions, `${s.pid}.json`), null);
      s.entrypoint = j && j.pid === s.pid ? (j.entrypoint || null) : null; changed = true;
    }
    if (pidAlive(s.pid) === false) {
      log('process gone', s.pid, 'session', s.id.slice(0, 8));
      sessions.delete(s.id); const run = runs.get(s.runKey); if (run) pruneRun(run); changed = true;
    }
  }
  if (Date.now() - lastImageCheck > T.imageCheck && process.platform === 'win32' && sessions.size) {
    lastImageCheck = Date.now();
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000, maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return;
      const names = new Map();
      for (const line of out.split(/\r?\n/)) { const m = /^"([^"]+)","(\d+)"/.exec(line); if (m) names.set(+m[2], m[1]); }
      for (const s of [...sessions.values()]) {
        if (!s.pid) continue;
        const nm = names.get(s.pid);
        if (!nm) continue;
        if (!s.imageName) { s.imageName = nm; continue; }
        if (nm.toLowerCase() !== s.imageName.toLowerCase()) {
          log('pid reused', s.pid, s.imageName, '->', nm); sessions.delete(s.id);
          const run = runs.get(s.runKey); if (run) pruneRun(run);
        }
      }
    });
  }
  if (changed) saveRegistry();
}

// ---------- prezentacja ----------
// ---------- widoczność okna aplikacji Claude desktop ----------
// Sesje aplikacji desktop (entrypoint "claude-desktop") działają dalej po zamknięciu
// okna (aplikacja zostaje w zasobniku). Taka sesja jest ukrywana, gdy proces-rodzic
// (aplikacja Claude) nie ma widocznego okna. Okno zminimalizowane = nadal widoczne.
let windowVis = {};           // pid sesji -> true/false
let appState = { visible: false, mode: 'unknown' }; // Claude desktop app: window visible? which tab?
let chatSince = null;         // when the regular Claude chat tab became the shown tab
function isChat() { return !!cfg.showChat && appState.visible && appState.mode === 'chat'; }
function applyWatch(v) {
  if (v && typeof v === 'object' && (v.vis || v.app)) { windowVis = v.vis || {}; appState = { visible: !!(v.app && v.app.visible), mode: (v.app && v.app.mode) || 'unknown' }; }
  else { windowVis = v || {}; appState = { visible: false, mode: 'unknown' }; }
}
let watcher = null, watcherPids = '', watcherRestartAt = 0, watcherFails = 0;
const WATCH_PIDS = path.join(C.P.data, 'state', 'window-pids.txt');

function isWindowed(s) { return cfg.hideWhenWindowClosed && s.entrypoint === 'claude-desktop' && !!s.pid; }
function isHidden(s) { return isWindowed(s) && windowVis[String(s.pid)] === false; }

function updateWindowWatch() {
  if (process.env.CDP_WINDOW_STATE_FILE) { applyWatch(C.readJson(process.env.CDP_WINDOW_STATE_FILE, {}) || {}); return; }
  const pids = [...sessions.values()].filter(isWindowed).map(s => s.pid).sort((a, b) => a - b).join(',');
  if (pids !== watcherPids) { try { C.ensureDir(path.dirname(WATCH_PIDS)); fs.writeFileSync(WATCH_PIDS, pids); } catch {} watcherPids = pids; }
  if (process.platform !== 'win32') return;
  if (!pids && !cfg.showChat) { if (watcher) { try { watcher.kill(); } catch {} watcher = null; } applyWatch({}); return; }
  if (watcher || Date.now() < watcherRestartAt) return;
  const { spawn } = require('child_process');
  const w = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(C.P.app, 'lib', 'window-watch.ps1'), '-DaemonPid', String(process.pid), '-PidFile', WATCH_PIDS], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  watcher = w;
  let buf = '';
  w.stdout.setEncoding('utf8');
  w.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      try { const v = JSON.parse(line); const before = JSON.stringify([windowVis, appState]); applyWatch(v); watcherFails = 0; if (JSON.stringify([windowVis, appState]) !== before) { log('window state', line); forceScan = true; setImmediate(tick); } } catch {}
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
  const TYPES = { playing: 0, listening: 2, watching: 3, competing: 5 };
  if (TYPES[cfg.activityType]) activity.type = TYPES[cfg.activityType];
  const img = largeImage();
  if (img) activity.assets = { large_image: img, large_text: 'Claude' };
  return { activity, debug: { mode: 'chat', chatSince: new Date(chatSince || Date.now()).toISOString(), note: 'regular Claude chat: no local token data' } };
}

function computePresence() {
  if (isChat()) { if (!chatSince) chatSince = Date.now(); return chatPresence(); }
  chatSince = null;
  const s = activeSession();
  if (!s) return null;
  const run = runs.get(s.runKey) || attachRun(s);
  const usages = [...run.usages.values()];
  for (const u of usages) { try { u.poll(); } catch (e) { log('poll', e.message); } }
  const hasSource = usages.some(u => u.hasSource);
  const agg = aggregate(usages, run.start, cfg.pricing);
  const scopeTotals = cfg.tokenScope === 'conversation' ? agg.conversation : agg.sinceLaunch;
  const value = hasSource ? countFor(scopeTotals, cfg.tokenCount) : null;
  const name = displayName(s.projectRoot, cfg);
  const L = C.strings(cfg.language);
  const fmt = C.formatTokens(value, cfg.language);
  const label = cfg.tokenScope === 'conversation' ? L.convTokens : L.sessionTokens;
  let state = fmt === null ? L.noData : `${label}: ${fmt}`;
  const cost = hasSource && cfg.showCost && scopeTotals.messages > scopeTotals.unpricedMessages ? formatCost(scopeTotals.costUsd, cfg.language) : null;
  if (cost) state += ` · ~${cost}${scopeTotals.unpricedMessages ? '+' : ''}`;
  if (cfg.showSessionCount && sessions.size > 1) state += ` · ${sessions.size} ${L.sessions}`;
  const activity = {
    details: name ? `${L.project}: ${name}` : L.hidden,
    state,
    timestamps: { start: Math.floor(run.start) },
  };
  // Discord shows only one "Playing" (type 0) activity at a time; another type lets it
  // appear next to e.g. the VS Code extension. RPC accepts 0, 2, 3, 5.
  const TYPES = { playing: 0, listening: 2, watching: 3, competing: 5 };
  if (cfg.activityType && TYPES[cfg.activityType] !== undefined && TYPES[cfg.activityType] !== 0) activity.type = TYPES[cfg.activityType];
  const img = largeImage();
  if (img) activity.assets = { large_image: img, large_text: cfg.largeImageText || 'Claude Code' };
  return {
    activity,
    debug: {
      sessionId: s.id, pid: s.pid, pidVia: s.pidVia || null, runStart: new Date(run.start).toISOString(),
      tokenSource: {
        kind: 'transcript-jsonl',
        files: usages.flatMap(u => [...u.tails.values()].map(t => ({ file: t.file, kind: t.kind, exists: t.exists, lines: t.lines, badLines: t.badLines, bytesRead: t.offset }))),
        uniqueMessages: usages.reduce((a, u) => a + u.messages.size, 0),
        duplicateLinesCollapsed: usages.reduce((a, u) => a + u.duplicateLines, 0),
        compactBoundariesSeen: usages.reduce((a, u) => a + u.compactions, 0),
        mode: cfg.tokenCount, scope: cfg.tokenScope, includeSubagents: cfg.includeSubagents,
        sinceLaunch: agg.sinceLaunch, conversationTotal: agg.conversation, published: value,
        cost: { published: cost, pricesDate: PRICES_DATE, basis: 'Anthropic API list prices; subscriptions are not billed per token' },
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
    lastPayloadJson = null; // po (ponownym) połączeniu wyślij aktywność od nowa – z tym samym znacznikiem start
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
    config: { enabled: cfg.enabled, applicationIdSet: !!cfg.applicationId, tokenCount: cfg.tokenCount, tokenScope: cfg.tokenScope, hideProject: cfg.hideProject },
    discord: { state: discordState, error: discordError, nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null, lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null },
    activityPayload: p ? p.activity : null,
    claudeApp: { windowVisible: appState.visible, tab: appState.mode, showingChat: isChat() },
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
    const newCfg = C.loadConfig();
    if (JSON.stringify(newCfg) !== JSON.stringify(cfg)) {
      const appChanged = newCfg.applicationId !== cfg.applicationId;
      cfg = newCfg; C.setLogMax(cfg.logMaxBytes); lastPayloadJson = null;
      if (appChanged && discord) { try { discord.close(); } catch {} discord = null; nextRetryAt = 0; retryDelay = T.backoffMin; }
      log('config reloaded');
    }
    if (!cfg.enabled) return shutdown('integration disabled');

    const gotEvents = processInbox();
    if (gotEvents || forceScan || Date.now() - lastScan >= T.scan) {
      lastScan = Date.now(); forceScan = false;
      checkLiveness();
      updateWindowWatch();
      lastPresence = computePresence();
      writeStatus(lastPresence);
    }

    if (!sessions.size && !isChat()) {
      if (Date.now() - noSessionsSince > T.grace) return shutdown('no open sessions');
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

server.on('error', e => {
  if (e.code === 'EADDRINUSE') process.exit(0); // inny proces już działa
  log('server error', e); process.exit(1);
});

function main() {
  if (!cfg.enabled) process.exit(0);
  C.ensureDir(C.P.inbox);
  const listen = () => server.listen(C.pipeName(), () => {
    log('daemon started', process.version, 'appId', cfg.applicationId ? 'set' : 'MISSING');
    loadRegistry();
    noSessionsSince = Date.now();
    setInterval(tick, T.tick);
    tick();
  });
  if (process.platform === 'win32') return listen();
  // Unix: osierocony plik gniazda po awarii – usuń tylko, jeśli nikt nie nasłuchuje.
  const probe = net.createConnection(C.pipeName());
  probe.once('connect', () => { probe.destroy(); process.exit(0); });
  probe.once('error', () => { try { fs.unlinkSync(C.pipeName()); } catch {} listen(); });
}

process.on('uncaughtException', e => { log('uncaught', e); });
process.on('unhandledRejection', e => { log('unhandled', e); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));

main();
