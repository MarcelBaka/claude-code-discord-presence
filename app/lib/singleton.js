'use strict';
// Single-instance lock for the background process.
//
// Windows: a named pipe can only be created once – a second listen fails (EADDRINUSE).
// macOS/Linux: bind() on an existing socket path fails too, but a socket left behind by a
// crashed process must be removed first, and "probe, unlink, listen" lets two processes
// starting at once both see a refused connection – the second one then deletes the first
// one's fresh socket (a socket that is bound but not yet listening also refuses
// connections). So every step happens while holding a short mkdir lock next to the socket:
//   lock → listen → (EADDRINUSE) probe: accepted = another instance runs → give up;
//   refused = stale → remove it (only if it is a socket owned by this user) → listen → unlock.
// No process binds or unlinks without the lock, so the probe can never hit a half-started peer.
const fs = require('fs');
const net = require('net');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function probe(p, ms = 700) {
  return new Promise(resolve => {
    const s = net.createConnection(p);
    const t = setTimeout(() => { s.destroy(); resolve('alive'); }, ms); // accepted but slow = alive
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('alive'); });
    s.once('error', e => {
      clearTimeout(t);
      resolve(e.code === 'ECONNREFUSED' ? 'stale' : e.code === 'ENOENT' ? 'absent' : 'error:' + e.code);
    });
  });
}

function tryListen(server, p) {
  return new Promise(resolve => {
    const onErr = e => { server.removeListener('listening', onOk); resolve(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(null); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p);
  });
}

function takeLock(lock) {
  try { fs.mkdirSync(lock, { mode: 0o700 }); return true; } catch (e) {
    if (e.code !== 'EEXIST') return false;
    // a holder that crashed inside the few-millisecond critical section
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch {}
    return false;
  }
}

function ownSocket(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isSocket() && (typeof process.getuid !== 'function' || st.uid === process.getuid());
  } catch { return false; }
}

// Resolves { ok: true, ino } when this process now owns the address, { ok: false, reason }
// when another live instance owns it (or the address cannot be used safely).
async function listenExclusive(server, p, { log = () => {}, attempts = 150 } = {}) {
  if (process.platform === 'win32' || /^\\\\[.?]\\pipe\\/i.test(p)) {
    const err = await tryListen(server, p);
    if (!err) return { ok: true };
    if (err.code === 'EADDRINUSE') return { ok: false, reason: 'running' };
    throw err;
  }
  const lock = `${p}.lock`;
  const listened = () => {
    try { fs.chmodSync(p, 0o600); } catch {}
    let ino = null; try { ino = fs.lstatSync(p).ino; } catch {}
    return { ok: true, ino };
  };
  for (let i = 0; i < attempts; i++) {
    if (!takeLock(lock)) { await sleep(20 + Math.floor(Math.random() * 60)); continue; }
    try {
      let err = await tryListen(server, p);
      if (!err) return listened();
      if (err.code !== 'EADDRINUSE') throw err;
      const st = await probe(p);
      if (st === 'alive') return { ok: false, reason: 'running' };
      if (st === 'absent') continue;
      if (st !== 'stale') return { ok: false, reason: `socket not usable (${st})` };
      if (!ownSocket(p)) return { ok: false, reason: 'stale socket is not ours – left in place' };
      try { fs.unlinkSync(p); log('removed a stale socket left by a previous process'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      err = await tryListen(server, p);
      if (!err) return listened();
      if (err.code !== 'EADDRINUSE') throw err;
    } finally { try { fs.rmdirSync(lock); } catch {} }
  }
  return { ok: false, reason: 'could not take the lock' };
}

// Remove our socket at shutdown – only if the file is still the one we created.
function releaseSocket(p, ino) {
  if (process.platform === 'win32' || !p || ino == null) return;
  try { if (fs.lstatSync(p).ino === ino) fs.unlinkSync(p); } catch {}
}

module.exports = { listenExclusive, releaseSocket, probe };
