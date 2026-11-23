'use strict';
// Minimal ZIP extractor in plain Node (zlib) – used by the updater on Linux, where `unzip`
// is often not installed. Reads the central directory, supports "stored" and "deflate"
// entries (all GitHub archives and our release ZIPs), keeps Unix permissions (e.g. the
// executable installer) and refuses entries that would land outside the target folder.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_TOTAL = 200 * 1024 * 1024; // refuse absurd archives (zip bombs)

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  throw new Error('not a ZIP archive (no end of central directory)');
}

function entries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    out.push({ name, method, csize, usize, local, mode: (extAttr >>> 16) & 0o777 });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// Extracts zipFile into outDir (created if needed). Throws on anything unexpected.
function extract(zipFile, outDir) {
  const buf = fs.readFileSync(zipFile);
  const root = path.resolve(outDir);
  fs.mkdirSync(root, { recursive: true });
  let total = 0;
  for (const e of entries(buf)) {
    const rel = e.name.replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) throw new Error(`unsafe path in ZIP: ${e.name}`);
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error(`unsafe path in ZIP: ${e.name}`);
    if (rel.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); continue; }
    if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`corrupt ZIP entry: ${e.name}`);
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const raw = buf.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) + 1024 });
    else throw new Error(`unsupported ZIP compression method ${e.method} (${e.name})`);
    if (data.length !== e.usize) throw new Error(`corrupt ZIP entry (size): ${e.name}`);
    total += data.length;
    if (total > MAX_TOTAL) throw new Error('ZIP archive too large');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data, { mode: e.mode ? (e.mode & 0o755) | 0o600 : 0o644 });
    if (process.platform !== 'win32' && e.mode) { try { fs.chmodSync(dest, (e.mode & 0o755) | 0o600); } catch {} }
  }
}

module.exports = { extract, entries };
