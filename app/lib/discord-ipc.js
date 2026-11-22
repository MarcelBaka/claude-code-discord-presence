'use strict';
// Minimalny klient lokalnego IPC desktopowego klienta Discord (Rich Presence).
// Ramka: [opcode u32 LE][długość u32 LE][JSON UTF-8].
// Opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG.
// Windows: \\?\pipe\discord-ipc-0..9. Nie używa żadnego tokenu konta ani bota –
// tylko publicznego Application ID.
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function candidatePaths() {
  if (process.env.CDP_DISCORD_PIPE_PREFIX) {
    return Array.from({ length: 10 }, (_, i) => `${process.env.CDP_DISCORD_PIPE_PREFIX}${i}`);
  }
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  // Linux/macOS – nieprzetestowane w tej instalacji, zostawione dla przenośności.
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  const dirs = [base, path.join(base, 'app/com.discordapp.Discord'), path.join(base, 'snap.discord')];
  const out = [];
  for (const d of dirs) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
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
    for (const p of candidatePaths()) {
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

module.exports = { DiscordIPC, encode, OP, candidatePaths };
