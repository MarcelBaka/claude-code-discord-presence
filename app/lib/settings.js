'use strict';
// Bezpieczna edycja ~/.claude/settings.json: kopia zapasowa, scalanie, idempotencja.
// Nie dotyka cudzych hooków ani statusLine.
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'CwdChanged', 'SessionEnd'];
const MARKER = /discord-presence[\\/]+hook\.js/i;

function settingsPath() { return process.env.CDP_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json'); }

function readSettings(file) {
  if (!fs.existsSync(file)) return { data: {}, raw: null };
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (!raw.trim()) return { data: {}, raw };
  const data = JSON.parse(raw); // błąd = przerwij bez zmian
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('settings.json nie jest obiektem JSON');
  return { data, raw };
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `settings.json.discord-presence-${ts}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.discord-presence.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function isOurs(h) { return h && typeof h.command === 'string' && MARKER.test(h.command); }

// Usuwa nasze wpisy, nie ruszając innych. Zwraca nowy obiekt.
function stripOurs(data) {
  const out = JSON.parse(JSON.stringify(data));
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const ev of Object.keys(out.hooks)) {
    const groups = out.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const hs = g.hooks.filter(h => !isOurs(h));
      if (hs.length === g.hooks.length) kept.push(g);
      else if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

function commandFor(nodePath, hookPath, ev) {
  const q = p => `"${p.replace(/\\/g, '/')}"`;
  return `${q(nodePath)} ${q(hookPath)} ${ev}`;
}

function addOurs(data, nodePath, hookPath) {
  const out = stripOurs(data);
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const ev of EVENTS) {
    if (!Array.isArray(out.hooks[ev])) out.hooks[ev] = [];
    out.hooks[ev].push({ hooks: [{ type: 'command', command: commandFor(nodePath, hookPath, ev), timeout: 10 }] });
  }
  return out;
}

function countOurs(data) {
  let n = 0;
  for (const groups of Object.values((data && data.hooks) || {})) if (Array.isArray(groups)) for (const g of groups) for (const h of (g && g.hooks) || []) if (isOurs(h)) n++;
  return n;
}

module.exports = { EVENTS, settingsPath, readSettings, backup, writeSettings, stripOurs, addOurs, countOurs, isOurs, commandFor };
