#!/usr/bin/env node
'use strict';
// Hook Claude Code (SessionStart / UserPromptSubmit / CwdChanged / SessionEnd).
// Zasady: NIC nie wypisuje na stdout/stderr (stdout SessionStart i UserPromptSubmit
// trafiłby do kontekstu Claude), kończy się szybko, zawsze kod wyjścia 0.
// Zapisuje zdarzenie do skrzynki i w razie potrzeby uruchamia proces w tle.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const done = () => process.exit(0);
const hardStop = setTimeout(done, 4000); // nigdy nie blokujemy Claude

let common;
try { common = require('./lib/common'); } catch { done(); }
const { P, pipeName, ensureDir, loadConfig, log } = common;

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 1500);
  });
}

function pingDaemon(msg) {
  return new Promise(resolve => {
    const s = net.createConnection(pipeName());
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 400);
    s.once('connect', () => { s.end(msg + '\n'); });
    s.once('data', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('close', () => { clearTimeout(t); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

function startDaemon() {
  const child = spawn(process.execPath, [path.join(P.app, 'daemon.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: P.data,
    env: { ...process.env },
  });
  child.unref();
}

(async () => {
  try {
    const cfg = loadConfig();
    if (!cfg.enabled) return done();
    const raw = await readStdin();
    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch { input = {}; }
    const event = input.hook_event_name || process.argv[2] || 'unknown';
    if (!input.session_id) return done();

    let projectRoot = null;
    const cwd = event === 'CwdChanged' ? (input.new_cwd || input.cwd) : input.cwd;
    try { const r = require('./lib/project').findProjectRoot(cwd); projectRoot = r && r.root; } catch {}

    // Tylko metadane – nigdy treść promptu.
    const ev = {
      event,
      sessionId: input.session_id,
      transcriptPath: input.transcript_path || null,
      cwd: cwd || null,
      projectRoot,
      source: input.source || null,
      reason: input.reason || null,
      hookPpid: process.ppid,
      at: Date.now(),
    };

    if (event === 'SessionEnd') {
      // Gdy demona nie ma, nie ma czego sprzątać.
      ensureDir(P.inbox);
      fs.writeFileSync(path.join(P.inbox, `${ev.at}-${process.pid}.tmp`), JSON.stringify(ev));
      fs.renameSync(path.join(P.inbox, `${ev.at}-${process.pid}.tmp`), path.join(P.inbox, `${ev.at}-${process.pid}.json`));
      await pingDaemon('nudge');
      return done();
    }

    ensureDir(P.inbox);
    const name = `${ev.at}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(path.join(P.inbox, name + '.tmp'), JSON.stringify(ev));
    fs.renameSync(path.join(P.inbox, name + '.tmp'), path.join(P.inbox, name + '.json'));

    const alive = await pingDaemon('nudge');
    if (!alive) startDaemon();
  } catch (e) {
    try { log('hook error', e); } catch {}
  }
  clearTimeout(hardStop);
  done();
})();
