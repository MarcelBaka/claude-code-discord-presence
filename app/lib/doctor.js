'use strict';
// `cli.js doctor`: checks the usual reasons why nothing (or the wrong thing) shows on Discord
// and says what to do. Read-only – it changes nothing.
const fs = require('fs');
const net = require('net');
const path = require('path');
const C = require('./common');
const S = require('./settings');

const OK = 'ok', WARN = 'warn', FAIL = 'fail';

function connectQuick(p, ms = 400) {
  return new Promise(resolve => {
    const s = net.createConnection(p);
    const done = v => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), ms);
    s.on('connect', () => done(true)); s.on('error', () => done(false));
  });
}

function ping() {
  return new Promise(resolve => {
    const s = net.createConnection(C.pipeName());
    const done = v => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), 1500);
    s.on('connect', () => s.write('ping\n')); s.on('data', d => done(String(d).trim() === 'pong'));
    s.on('error', () => done(false)); s.on('close', () => done(false));
  });
}

// unquote a hook command's executable/script paths ("…" on Windows, '…' on macOS/Linux)
function commandPaths(cmd) {
  const out = [];
  const re = /"([^"]+)"|'((?:[^']|'\\'')+)'/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1] : m[2].replace(/'\\''/g, "'"));
  return out;
}

async function runChecks({ discordPaths, pingDaemon = ping, connect = connectQuick } = {}) {
  const r = [];
  const add = (level, title, fix) => r.push({ level, title, fix: fix || null });
  const cli = process.platform === 'win32' ? `node "${path.join(C.P.app, 'cli.js')}"` : `node ${path.join(C.P.app, 'cli.js')}`;

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) add(OK, `Node.js ${process.version}`);
  else add(FAIL, `Node.js ${process.version} is too old`, 'Install Node.js 18 or newer (LTS) from https://nodejs.org and re-run the installer.');

  // version / install
  const ver = require('./version').installedVersion(C.P.app);
  add(ver ? OK : WARN, `Installed in ${C.P.app}${ver ? ` (version ${ver})` : ''}`, ver ? null : 'Re-run the installer from the latest release.');

  // config
  let cfg;
  try { cfg = C.loadConfig(); } catch (e) { add(FAIL, 'config.json cannot be read', `Fix or delete ${C.P.config} and re-run the installer.`); cfg = null; }
  if (cfg) {
    if (!cfg.enabled) add(FAIL, 'The integration is disabled', `${cli} enable`);
    else add(OK, 'Integration enabled');
    const until = Number(cfg.pausedUntil) || 0;
    if (until === -1 || until > Date.now()) add(WARN, `Paused ${until === -1 ? 'until you resume' : `until ${new Date(until).toLocaleString()}`} – the card is hidden`, `${cli} resume`);
    add(OK, `Discord application: ${cfg.applicationIdIsDefault ? 'built-in "ClaudeCode"' : `your own (${cfg.applicationId})`}`);
  }

  // hooks in settings.json
  try {
    const sp = S.settingsPath();
    const st = S.readSettings(sp);
    const n = S.countOurs(st.data);
    if (n === S.EVENTS.length) add(OK, `Claude Code hooks installed (${n}/${S.EVENTS.length}) in ${sp}`);
    else if (n === 0) add(FAIL, 'No Claude Code hooks found', 'Re-run the installer (node install.js) – then restart Claude Code.');
    else add(WARN, `Only ${n} of ${S.EVENTS.length} hooks installed`, 'Re-run the installer to update the hooks, then restart Claude Code.');
    const ours = Object.values(st.data.hooks || {}).flat().flatMap(g => (g && g.hooks) || []).filter(S.isOurs);
    const missing = new Set();
    for (const h of ours) for (const p of commandPaths(h.command).slice(0, 2)) if (!fs.existsSync(p)) missing.add(p);
    if (missing.size) add(FAIL, `A hook points to a missing file: ${[...missing].join(', ')}`, 'Node or the install folder moved – re-run the installer.');
  } catch (e) { add(FAIL, `settings.json cannot be read: ${e.message}`, 'Fix the JSON in ~/.claude/settings.json, then re-run the installer.'); }

  // Discord desktop
  const paths = discordPaths || require('./discord-ipc').candidatePaths();
  let found = null;
  for (const p of paths) { if (await connect(p)) { found = p; break; } }
  if (found) add(OK, 'Discord desktop is running (local RPC reachable)');
  else add(FAIL, 'Discord desktop is not running or its local RPC is not reachable', 'Start the Discord desktop app (the browser version has no local RPC). Flatpak/Snap Discord may need extra permissions.');

  // background process + Discord connection + sessions
  const alive = await pingDaemon();
  const status = C.readJson(C.P.status, null);
  if (!alive) add(WARN, 'Background process not running', 'It starts on the next Claude Code event (send a prompt). If it never starts, check the hooks above and the log.');
  else {
    add(OK, `Background process running (PID ${(status && status.daemonPid) || '?'})`);
    const d = status && status.discord;
    if (d && d.state === 'connected') add(OK, 'Connected to Discord');
    else if (d && /Invalid Client ID/i.test(d.error || '')) add(FAIL, 'Discord rejected the Application ID (Invalid Client ID)', `${cli} set-app-id default   (or re-copy your own ID)`);
    else if (d) add(WARN, `Not connected to Discord yet (${d.state}${d.error ? `: ${d.error}` : ''})`, 'Start Discord – the integration reconnects by itself.');
    const n = status && Array.isArray(status.sessions) ? status.sessions.length : 0;
    if (n) add(OK, `${n} Claude Code session${n === 1 ? '' : 's'} tracked`);
    else add(WARN, 'No Claude Code session is tracked', 'Restart open Claude Code sessions (hooks load at session start), then send a prompt.');
    if (status && status.activityPayload && d && d.state === 'connected') {
      add(OK, 'An activity is being sent', 'Still not visible? In Discord: User Settings → Activity Privacy → turn on "Share my activity" (and check the server privacy settings).');
    }
    if (status && status.update && status.update.updateAvailable) add(WARN, `Update available: ${status.update.latest} (installed ${status.update.installed})`, `${cli} update`);
  }

  // autostart consistency
  try {
    const a = require('./autostart');
    const on = a.isEnabled();
    if (cfg && cfg.autostart && !on) add(WARN, 'autostart is on in config.json but the sign-in entry is missing', `${cli} autostart on`);
    else if (on) add(OK, 'Start at sign-in is on');
  } catch {}

  // recent errors in the log
  try {
    const lines = fs.readFileSync(C.P.log, 'utf8').trimEnd().split('\n').slice(-300);
    const bad = lines.filter(l => /\b(error|failed|uncaught|unhandled)\b/i.test(l) && !/discord connect failed|update check failed|price table refresh failed/i.test(l));
    if (bad.length) add(WARN, `${bad.length} error line(s) in the recent log, last: ${bad[bad.length - 1].slice(0, 160)}`, `${cli} logs`);
  } catch {}

  return r;
}

function format(results) {
  const icon = { ok: '✔', warn: '⚠', fail: '✗' };
  const lines = results.map(x => `${icon[x.level]} ${x.title}${x.fix ? `\n    → ${x.fix}` : ''}`);
  const fails = results.filter(x => x.level === FAIL).length, warns = results.filter(x => x.level === WARN).length;
  lines.push('', fails ? `${fails} problem(s) to fix.` : warns ? `No blocking problems (${warns} note(s)).` : 'Everything looks fine.');
  return lines.join('\n');
}

module.exports = { runChecks, format, commandPaths, OK, WARN, FAIL };
