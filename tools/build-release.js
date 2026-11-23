#!/usr/bin/env node
'use strict';
// Builds the release downloads – no dependencies, no external tools:
//   dist/claude-code-discord-presence-<version>-macos.zip    (install-macos.command, executable)
//   dist/claude-code-discord-presence-<version>-windows.zip  (install-windows.cmd, CRLF)
//   dist/claude-code-discord-presence-<version>-linux.zip    (install-linux.sh, executable)
// Each ZIP has one top folder with the app, install.js, README, LICENSE and the installer.
// Usage: node tools/build-release.js <version> [outDir]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'claude-code-discord-presence';
const COMMON = ['app', 'assets', 'install.js', 'README.md', 'CHANGELOG.md', 'LICENSE', 'config.example.json'];

// ---------- minimal ZIP writer (deflate, Unix permissions in the external attributes) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// entries: [{ name: 'dir/file', data: Buffer, mode: 0o644 }]
function zip(entries, mtime = new Date()) {
  const dosTime = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | Math.floor(mtime.getSeconds() / 2);
  const dosDate = ((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();
  const local = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : e.data;
    const comp = isDir ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = isDir ? 0 : 8;
    const crc = crc32(data);
    const mode = (isDir ? 0o040000 : 0o100000) | (e.mode || (isDir ? 0o755 : 0o644));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); // made by Unix, v2.0
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

function collect(rel, out = []) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    out.push({ rel: rel + '/', dir: true });
    for (const n of fs.readdirSync(abs).sort()) collect(path.join(rel, n), out);
  } else out.push({ rel, abs });
  return out;
}

function build(version, outDir = path.join(ROOT, 'dist')) {
  if (!/^v?\d+\.\d+\.\d+([-.][\w.]+)?$/.test(version || '')) throw new Error('version must look like 1.2.3 or v1.2.3');
  const v = version.replace(/^v/, '');
  const top = `${NAME}-${v}/`;
  const files = COMMON.flatMap(r => collect(r));
  const base = files.map(f => ({ name: top + f.rel.split(path.sep).join('/'), data: f.dir ? null : fs.readFileSync(f.abs), mode: f.dir ? 0o755 : 0o644 }));
  const installer = n => fs.readFileSync(path.join(ROOT, 'installer', n));
  const lf = b => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const crlf = b => Buffer.from(lf(b).toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
  const targets = {
    macos: [{ name: top, data: null, mode: 0o755 }, ...base, { name: top + 'install-macos.command', data: lf(installer('install-macos.command')), mode: 0o755 }],
    windows: [{ name: top, data: null, mode: 0o755 }, ...base, { name: top + 'install-windows.cmd', data: crlf(installer('install-windows.cmd')), mode: 0o644 }],
    linux: [{ name: top, data: null, mode: 0o755 }, ...base, { name: top + 'install-linux.sh', data: lf(installer('install-linux.sh')), mode: 0o755 }],
  };
  fs.mkdirSync(outDir, { recursive: true });
  const out = {};
  for (const [k, entries] of Object.entries(targets)) {
    const f = path.join(outDir, `${NAME}-${v}-${k}.zip`);
    fs.writeFileSync(f, zip(entries));
    out[k] = f;
  }
  return out;
}

module.exports = { build, zip, crc32 };

if (require.main === module) {
  try {
    const r = build(process.argv[2], process.argv[3] ? path.resolve(process.argv[3]) : undefined);
    for (const f of Object.values(r)) console.log(`${f}  (${fs.statSync(f).size} bytes)`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
