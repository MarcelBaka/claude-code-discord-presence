'use strict';
// Minimalny klient lokalnego IPC desktopowego klienta Discord (Rich Presence).
// Ramka: [opcode u32 LE][długość u32 LE][JSON UTF-8].
// Opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG.
// Windows: \\?\pipe\discord-ipc-0..9; macOS/Linux: <dir>/discord-ipc-0..9 (Unix socket). Nie używa żadnego tokenu konta ani bota –
// tylko publicznego Application ID.
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

// Directories where the desktop Discord client creates discord-ipc-<n>.
// The official SDK takes the first of XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP (else /tmp).
// A process started by a hook, the Claude desktop app or launchd may see a different
// environment than Discord did (e.g. no TMPDIR), so every candidate is tried, plus the
// per-user temporary directory macOS assigns (`getconf DARWIN_USER_TEMP_DIR`, the value
// TMPDIR normally has in a GUI session) and the Flatpak/Snap locations on Linux.
let darwinTempCache;
function darwinUserTemp() {
  if (darwinTempCache !== undefined) return darwinTempCache;
  darwinTempCache = null;
  try {
    const out = require('child_process').execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out.startsWith('/')) darwinTempCache = out;
  } catch {}
  return darwinTempCache;
}

function candidateDirs({ env = process.env, platform = process.platform, darwinTemp } = {}) {
  if (env.CDP_DISCORD_IPC_DIRS) return env.CDP_DISCORD_IPC_DIRS.split(path.delimiter).filter(Boolean);
  const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP];
  if (platform === 'darwin') bases.push(darwinTemp !== undefined ? darwinTemp : darwinUserTemp());
  if (platform === 'linux' && typeof process.getuid === 'function') bases.push(`/run/user/${process.getuid()}`);
  bases.push('/tmp');
  const dirs = [];
  for (const b of bases) {
    if (!b || typeof b !== 'string' || !b.startsWith('/')) continue;
    dirs.push(b);
    if (platform === 'linux') dirs.push(path.posix.join(b, 'app/com.discordapp.Discord'), path.posix.join(b, 'snap.discord'), path.posix.join(b, '.flatpak/dev.vencord.Vesktop/xdg-run'));
  }
  const seen = new Set();
  return dirs.map(d => path.posix.normalize(d).replace(/(.)\/+$/, '$1')).filter(d => !seen.has(d) && seen.add(d));
}

function candidatePaths(opts = {}) {
  const env = opts.env || process.env;
  if (env.CDP_DISCORD_PIPE_PREFIX) return Array.from({ length: 10 }, (_, i) => `${env.CDP_DISCORD_PIPE_PREFIX}${i}`);
  if ((opts.platform || process.platform) === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const out = [];
  for (const d of candidateDirs(opts)) for (let i = 0; i < 10; i++) out.push(path.posix.join(d, `discord-ipc-${i}`));
  return out;
}

function encode(op, obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(8);
  h.writeUInt32LE(op, 0); h.writeUInt32LE(json.length, 4);
  return Buffer.concat([h, json]);
}

function tryConnect(p, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(p);
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', e => { clearTimeout(t); reject(e); });
  });
}

class DiscordIPC extends EventEmitter {
  constructor(clientId) {
    super();
    this.clientId = clientId;
    this.sock = null; this.buf = Buffer.alloc(0);
    this.ready = false; this.pending = new Map(); this.user = null;
  }

  async connect() {
    let lastErr = new Error('Discord is not running (no discord-ipc pipe)');
    const fs = require('fs');
    for (const p of candidatePaths()) {
      if (!p.startsWith('\\\\') && !fs.existsSync(p)) continue; // Unix: no socket file, nothing to try
      let s;
      try { s = await tryConnect(p, 1000); } catch (e) { if (e.code !== 'ENOENT') lastErr = e; continue; }
      try { await this._handshake(s); return; } catch (e) { lastErr = e; try { s.destroy(); } catch {} }
    }
    throw lastErr;
  }

  _handshake(s) {
    return new Promise((resolve, reject) => {
      this.sock = s; this.buf = Buffer.alloc(0); this.ready = false; this.lastCloseError = null;
      const t = setTimeout(() => fail(new Error('no READY response from Discord')), 5000);
      const fail = e => { clearTimeout(t); this.removeListener('_ready', ok); reject(e); };
      const ok = () => { clearTimeout(t); resolve(); };
      this.once('_ready', ok);
      s.on('data', d => this._onData(d));
      s.on('error', e => { if (!this.ready) fail(e); else this.emit('error', e); });
      s.on('close', () => {
        const was = this.ready; this.ready = false; this.sock = null;
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
        if (was) this.emit('disconnected'); else fail(this.lastCloseError || new Error('Discord closed the connection during handshake'));
      });
      s.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0), len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg = null;
      try { msg = JSON.parse(this.buf.toString('utf8', 8, 8 + len)); } catch {}
      this.buf = this.buf.subarray(8 + len);
      if (op === OP.PING) { this._write(OP.PONG, msg || {}); continue; }
      if (op === OP.CLOSE) {
        const err = new Error(`Discord closed IPC: ${msg && (msg.message || msg.code)}`);
        err.discordCode = msg && msg.code;
        this.emit('closeFrame', err);
        this.lastCloseError = err;
        try { this.sock && this.sock.destroy(); } catch {}
        continue;
      }
      if (op !== OP.FRAME || !msg) continue;
      if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
        this.ready = true; this.user = msg.data && msg.data.user ? { id: msg.data.user.id } : null;
        this.emit('_ready'); this.emit('ready');
        continue;
      }
      if (msg.nonce && this.pending.has(msg.nonce)) {
        const p = this.pending.get(msg.nonce); this.pending.delete(msg.nonce);
        if (msg.evt === 'ERROR') p.reject(new Error(`Discord: ${msg.data && msg.data.message}`)); else p.resolve(msg.data);
      }
    }
  }

  _write(op, obj) { if (this.sock) this.sock.write(encode(op, obj)); }

  request(cmd, args) {
    if (!this.ready || !this.sock) return Promise.reject(new Error('not connected to Discord'));
    const nonce = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(nonce); reject(new Error(`timeout ${cmd}`)); }, 10000);
      this.pending.set(nonce, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this._write(OP.FRAME, { cmd, args, nonce });
    });
  }

  // activity === null czyści aktywność
  setActivity(activity, pid = process.pid) {
    return this.request('SET_ACTIVITY', activity ? { pid, activity } : { pid });
  }

  close() {
    if (!this.sock) return;
    try { this._write(OP.CLOSE, {}); } catch {}
    try { this.sock.end(); } catch {}
    const s = this.sock; setTimeout(() => { try { s.destroy(); } catch {} }, 200);
  }
}

module.exports = { DiscordIPC, encode, OP, candidatePaths, candidateDirs };
