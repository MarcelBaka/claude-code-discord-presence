#!/usr/bin/env node
'use strict';
// Instalator (idempotentny). Użycie: node install.js [--app-id <ID>]
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const S = require('./app/lib/settings');

const SRC = path.join(__dirname, 'app');
const DEST = process.env.CDP_INSTALL_DIR || path.join(os.homedir(), '.claude', 'discord-presence');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function stopDaemon(dir) {
  // ten sam algorytm nazwy potoku co w lib/common.js
  const prev = process.env.CDP_DATA_DIR; process.env.CDP_DATA_DIR = dir;
  delete require.cache[require.resolve('./app/lib/common')];
  const name = require('./app/lib/common').pipeName();
  if (prev === undefined) delete process.env.CDP_DATA_DIR; else process.env.CDP_DATA_DIR = prev;
  return new Promise(resolve => {
    const s = net.createConnection(name);
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 1500);
    s.on('connect', () => s.write('stop\n'));
    s.on('close', () => { clearTimeout(t); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

(async () => {
  const argi = process.argv.indexOf('--app-id');
  const appId = argi > 0 ? String(process.argv[argi + 1] || '').trim() : '';
  if (appId && !/^\d{15,22}$/.test(appId)) { console.error('Invalid Application ID.'); process.exit(1); }

  // 1. settings.json – najpierw walidacja, żeby nic nie zmieniać przy błędzie
  const sp = S.settingsPath();
  let cur;
  try { cur = S.readSettings(sp); } catch (e) { console.error(`Cannot read ${sp}: ${e.message}. Nothing was changed.`); process.exit(1); }

  // 2. pliki aplikacji (konfiguracja użytkownika i stan zostają nietknięte)
  const wasRunning = await stopDaemon(DEST);
  copyDir(SRC, DEST);
  fs.copyFileSync(path.join(__dirname, 'README.md'), path.join(DEST, 'README.md'));
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), path.join(DEST, 'config.example.json'));
  const cfgPath = path.join(DEST, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, '')); } catch {}
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
  const merged = { ...example, ...cfg };
  if (appId) merged.applicationId = appId;
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  // 3. hooki
  const next = S.addOurs(cur.data, process.execPath, path.join(DEST, 'hook.js'));
  let bak = null;
  if (JSON.stringify(next) !== JSON.stringify(cur.data)) {
    bak = S.backup(sp);
    S.writeSettings(sp, next);
  }

  console.log('Discord Rich Presence for Claude Code installed.');
  console.log(`  files:   ${DEST}`);
  console.log(`  config:  ${cfgPath}`);
  console.log(`  hooks:   ${sp} (${S.countOurs(next)} entries: ${S.EVENTS.join(', ')})${bak ? '' : ' – unchanged'}`);
  if (bak) console.log(`  backup:  ${bak}`);
  if (wasRunning) console.log('  stopped the previous background process (the new version starts on the next Claude event)');
  if (!merged.applicationId) console.log('\nApplication ID MISSING – see README, then: node "' + path.join(DEST, 'cli.js') + '" set-app-id <ID>');
  console.log('\nRestart open Claude Code sessions so they load the new hooks.');
})();
