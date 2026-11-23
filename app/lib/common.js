'use strict';
// Wspólne narzędzia: ścieżki, konfiguracja, logi, zapis atomowy, formatowanie.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.CDP_DATA_DIR || APP_DIR;
const CLAUDE_DIR = process.env.CDP_CLAUDE_DIR || path.join(os.homedir(), '.claude');

const P = {
  app: APP_DIR,
  data: DATA_DIR,
  config: path.join(DATA_DIR, 'config.json'),
  inbox: path.join(DATA_DIR, 'state', 'inbox'),
  registry: path.join(DATA_DIR, 'state', 'registry.json'),
  status: path.join(DATA_DIR, 'state', 'status.json'),
  logDir: path.join(DATA_DIR, 'logs'),
  log: path.join(DATA_DIR, 'logs', 'presence.log'),
  claudeSessions: path.join(CLAUDE_DIR, 'sessions'),
};

// Address of the background process – the same function is used by the hook, the daemon,
// the CLI, the installer and the uninstaller.
// Windows: a per-user named pipe. macOS/Linux: a Unix socket in the private state
// directory; when that path is longer than the sun_path limit (104 bytes on macOS,
// 108 on Linux), a socket in a per-user 0700 directory under /tmp named after a hash of
// the data directory (deterministic, so every component finds the same address).
const SUN_PATH_MAX = 100;
function uidTag() { return typeof process.getuid === 'function' ? String(process.getuid()) : (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_-]/g, '_'); }

// Creates (or accepts) a directory only if it is a real directory owned by this user
// with no access for group/others. Never follows a symlink planted by someone else.
function privateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') return false; }
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (process.platform === 'win32') return true;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
    return true;
  } catch { return false; }
}

function pipeName() {
  if (process.env.CDP_PIPE_NAME) return process.env.CDP_PIPE_NAME;
  const user = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_-]/g, '_');
  if (process.platform === 'win32') return `\\\\.\\pipe\\claude-code-discord-presence-${user}`;
  const p = path.join(DATA_DIR, 'state', 'daemon.sock');
  if (Buffer.byteLength(p) <= SUN_PATH_MAX) return p;
  const h = crypto.createHash('sha256').update(path.resolve(DATA_DIR)).digest('hex').slice(0, 16);
  const base = process.env.CDP_SOCKET_BASE || '/tmp';
  for (const d of [path.join(base, `cdp-${uidTag()}`), path.join(base, `cdp-${uidTag()}-${h.slice(0, 8)}`)]) {
    if (privateDir(d)) return path.join(d, `${h}.sock`);
  }
  return p; // no safe short directory – listen fails and the reason is logged
}

const DEFAULT_CONFIG = {
  enabled: true,
  language: 'en',
  applicationId: '',
  hideProject: false,
  hiddenProjects: [],
  aliases: {},
  tokenCount: 'no_cache_read',
  tokenScope: 'launch',
  includeSubagents: true,
  showSessionCount: false,
  showCost: true,
  activityType: 'watching',
  showChat: true,
  showStatus: true,
  showModel: true,
  showToday: 'rotate',
  links: {},
  autostart: false,
  assetBaseUrl: 'https://raw.githubusercontent.com/MarcelBaka/claude-code-discord-presence/main/assets',
  updateRepo: 'MarcelBaka/claude-code-discord-presence',
  pricing: {},
  hideWhenWindowClosed: true,
  macAccessibility: false,
  largeImageKey: '',
  largeImageText: 'Claude Code',
  logMaxBytes: 524288,
};

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
// state/ and logs/ hold session metadata – private to the user on macOS/Linux
function ensurePrivateDirs() { for (const d of [path.dirname(P.registry), P.inbox, P.logDir]) { ensureDir(d); if (process.platform !== 'win32') { try { fs.chmodSync(d, 0o700); } catch {} } } }

function readJson(file, fallback) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    return JSON.parse(txt);
  } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows: plik chwilowo otwarty przez inny proces
      if (i >= 10) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      const until = Date.now() + 20; while (Date.now() < until) { /* krótkie czekanie */ }
    }
  }
}

function loadConfig() {
  const user = readJson(P.config, {}) || {};
  const cfg = { ...DEFAULT_CONFIG, ...user };
  if (!cfg.aliases || typeof cfg.aliases !== 'object') cfg.aliases = {};
  if (!Array.isArray(cfg.hiddenProjects)) cfg.hiddenProjects = [];
  if (!['all', 'no_cache_read', 'output'].includes(cfg.tokenCount)) cfg.tokenCount = 'no_cache_read';
  if (!['launch', 'conversation'].includes(cfg.tokenScope)) cfg.tokenScope = 'launch';
  cfg.applicationId = String(cfg.applicationId || '').trim();
  if (!['en', 'pl'].includes(cfg.language)) cfg.language = 'en';
  if (!['playing', 'listening', 'watching', 'competing'].includes(cfg.activityType)) cfg.activityType = 'watching';
  if (!['rotate', 'tooltip', 'off'].includes(cfg.showToday)) cfg.showToday = cfg.showToday === false ? 'off' : 'rotate';
  if (!cfg.links || typeof cfg.links !== 'object') cfg.links = {};
  return cfg;
}

let logMax = DEFAULT_CONFIG.logMaxBytes;
function setLogMax(n) { if (Number.isFinite(n) && n > 10000) logMax = n; }
function log(...args) {
  try {
    ensureDir(P.logDir);
    const line = `${new Date().toISOString()} [${process.pid}] ${args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    try {
      const st = fs.statSync(P.log);
      if (st.size + line.length > logMax) {
        try { fs.rmSync(P.log + '.1', { force: true }); } catch {}
        fs.renameSync(P.log, P.log + '.1');
      }
    } catch {}
    fs.appendFileSync(P.log, line, 'utf8');
  } catch { /* logi nigdy nie mogą przerwać pracy */ }
}

// 999 → "999", 12 400 → "12,4 tys.", 1 250 000 → "1,25 mln", 3,2e9 → "3,2 mld"
// en: 12400 → "12.4k", 1250000 → "1.25M", 3.2e9 → "3.2B"
function formatTokens(n, lang = 'pl') {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const en = lang === 'en';
  const trim = s => { s = s.replace(/\.?0+$/, ''); return en ? s : s.replace('.', ','); };
  const u = en ? ['k', 'M', 'B'] : [' tys.', ' mln', ' mld'];
  if (n < 1000) return String(Math.round(n));
  if (n < 999950) return trim((n / 1e3).toFixed(1)) + u[0];
  if (n < 999995000) return trim((n / 1e6).toFixed(2)) + u[1];
  return trim((n / 1e9).toFixed(2)) + u[2];
}

const STRINGS = {
  en: { project: 'Project', hidden: 'Project hidden', sessionTokens: 'Session tokens', convTokens: 'Conversation tokens', noData: 'Tokens: no data', sessions: 'sessions', chat: 'Chatting with Claude', working: 'Working', waiting: 'Waiting', workingLong: 'Claude is working…', waitingLong: 'Waiting for you', tokensWord: 'tokens', today: 'Today', effort: 'effort', githubButton: 'View on GitHub', openButton: 'Open project' },
  pl: { project: 'Projekt', hidden: 'Projekt ukryty', sessionTokens: 'Tokeny sesji', convTokens: 'Tokeny rozmowy', noData: 'Tokeny: brak danych', sessions: 'sesje', chat: 'Rozmawia z Claude', working: 'Pracuje', waiting: 'Czeka', workingLong: 'Claude pracuje…', waitingLong: 'Czeka na Ciebie', tokensWord: 'tokenów', today: 'Dziś', effort: 'effort', githubButton: 'Zobacz na GitHubie', openButton: 'Otwórz projekt' },
};
function strings(lang) { return STRINGS[lang] || STRINGS.en; }

module.exports = { P, pipeName, privateDir, ensurePrivateDirs, SUN_PATH_MAX, DEFAULT_CONFIG, ensureDir, readJson, writeJsonAtomic, loadConfig, log, setLogMax, formatTokens, strings };
