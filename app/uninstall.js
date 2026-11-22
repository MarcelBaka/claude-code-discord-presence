#!/usr/bin/env node
'use strict';
// Deinstalator. Użycie: node uninstall.js [--keep-files]
// Usuwa wyłącznie wpisy tej integracji z settings.json (po kopii zapasowej),
// czyści aktywność Discord, zatrzymuje proces i usuwa katalog integracji.
const fs = require('fs');
const path = require('path');
const net = require('net');
const S = require('./lib/settings');
const C = require('./lib/common');

(async () => {
  await new Promise(resolve => {
    const s = net.createConnection(C.pipeName());
    const t = setTimeout(() => { s.destroy(); resolve(); }, 2500);
    s.on('connect', () => s.write('stop\n'));
    s.on('close', () => { clearTimeout(t); setTimeout(resolve, 800); });
    s.on('error', () => { clearTimeout(t); resolve(); });
  });

  const sp = S.settingsPath();
  try {
    const cur = S.readSettings(sp);
    const n = S.countOurs(cur.data);
    if (n) {
      const bak = S.backup(sp);
      S.writeSettings(sp, S.stripOurs(cur.data));
      console.log(`Removed ${n} hooks from ${sp} (backup: ${bak}).`);
    } else console.log('No integration hooks found in settings.json.');
  } catch (e) { console.error(`Cannot modify ${sp}: ${e.message}`); process.exitCode = 1; }

  if (!process.argv.includes('--keep-files')) {
    const dir = C.P.app;
    if (/discord-presence$/i.test(dir)) {
      // Windows nie pozwala usunąć uruchomionego skryptu z jego katalogu w pełni – usuwamy zawartość
      for (const e of fs.readdirSync(dir)) { try { fs.rmSync(path.join(dir, e), { recursive: true, force: true }); } catch {} }
      try { fs.rmdirSync(dir); } catch {}
      console.log(`Removed ${dir}.`);
    }
  } else console.log('Files kept (--keep-files).');
  console.log('Done. Open Claude Code sessions may need a restart to stop calling the hooks.');
})();
