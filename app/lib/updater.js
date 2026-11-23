'use strict';
// `cli.js update`: download the latest release (or the main branch / a given version) as a
// ZIP, unpack it with a system tool and rerun its installer into the current install
// directory (config.json, the Application ID and state stay – the installer never
// overwrites them). Every external tool gets its arguments as an array (no shell string).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const versionLib = require('./version');

// Which system tool unpacks the ZIP on this platform.
function unpackCommand(zip, outDir, platform = process.platform) {
  if (platform === 'win32') {
    // bsdtar shipped with Windows 10 1803+ / 11 reads ZIP files; paths are plain arguments
    return { cmd: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), args: ['-xf', zip, '-C', outDir] };
  }
  if (platform === 'darwin') return { cmd: '/usr/bin/ditto', args: ['-x', '-k', zip, outDir] };
  // Linux (and anything else): the built-in extractor – `unzip` is often not installed
  return { builtin: true };
}

function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { headers: { 'User-Agent': 'claude-code-discord-presence' }, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve(download(new URL(res.headers.location, url).href, dest, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const out = fs.createWriteStream(dest);
      res.on('error', reject);
      res.pipe(out); out.on('finish', () => out.close(resolve)); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}

// What to download:
//   ref 'release' (default) – the latest published release (its tag), skipped when the
//                             installed version is already that new (unless force)
//   ref 'main'              – the main branch (unreleased changes)
//   ref '1.2.3' / 'v1.2.3'  – that release tag (also older ones)
async function resolveTarget({ repo, ref = 'release', force = false, installed, latest, log }) {
  if (ref === 'main') return { url: `https://codeload.github.com/${repo}/zip/refs/heads/main`, label: 'main branch' };
  if (ref === 'release') {
    const r = await latest(repo);
    if (!force && installed && versionLib.compare(r.version, installed) <= 0) {
      log(`Already up to date: installed ${installed}, latest release ${r.version}. (--force reinstalls it, --main takes unreleased changes.)`);
      return null;
    }
    return { url: `https://codeload.github.com/${repo}/zip/refs/tags/${encodeURIComponent(r.tag)}`, label: `release ${r.tag}`, version: r.version };
  }
  if (!versionLib.parse(ref)) throw new Error(`"${ref}" is not a version – use update, update --main or update <version>, e.g. update 1.1.0.`);
  const tag = ref.startsWith('v') ? ref : `v${ref}`;
  return { url: `https://codeload.github.com/${repo}/zip/refs/tags/${encodeURIComponent(tag)}`, label: `release ${tag}`, version: tag.slice(1) };
}

// Throws on any failure; the temporary directory is removed in every case.
// Returns { status: 'updated', label, version } or { status: 'current' }.
async function update({ repo, appDir, ref = 'release', force = false, installed = versionLib.installedVersion(appDir), latest = versionLib.latestRelease, platform = process.platform, fetch = download, log = console.log, nodePath = process.execPath, run = spawnSync }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('updateRepo in config.json must look like "owner/name".');
  let target;
  try { target = await resolveTarget({ repo, ref, force, installed, latest, log }); }
  catch (e) {
    if (e.code === 'NO_RELEASE') throw new Error(`${repo} has no published release yet – use "update --main" for the main branch.`);
    throw e;
  }
  if (!target) return { status: 'current' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-update-'));
  try {
    const zip = path.join(tmp, 'source.zip');
    log(`Downloading https://github.com/${repo} (${target.label})…`);
    try { await fetch(target.url, zip); }
    catch (e) { if (/HTTP 404/.test(e.message) && target.version) throw new Error(`No release ${target.label.replace('release ', '')} in ${repo}.`); throw e; }
    const head = Buffer.alloc(4);
    const fd = fs.openSync(zip, 'r'); try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('The download is not a ZIP archive.');
    const outDir = path.join(tmp, 'x');
    fs.mkdirSync(outDir);
    const u = unpackCommand(zip, outDir, platform);
    if (u.builtin) {
      try { require('./unzip').extract(zip, outDir); } catch (e) { throw new Error(`Could not unpack the download: ${e.message}`); }
    } else {
      const ex = run(u.cmd, u.args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      if (ex.error || ex.status !== 0) throw new Error(`Could not unpack the download (${u.cmd}): ${(ex.error && ex.error.message) || (ex.stderr || '').trim() || `exit ${ex.status}`}`);
    }
    // GitHub ZIPs have one top folder (<repo>-main/); accept a flat archive too
    const top = [outDir, ...fs.readdirSync(outDir).map(n => path.join(outDir, n))].find(d => fs.existsSync(path.join(d, 'install.js')));
    if (!top) throw new Error(`The download does not contain install.js (unpacked: ${fs.readdirSync(outDir).slice(0, 10).join(', ') || 'nothing'}).`);
    const r = run(nodePath, [path.join(top, 'install.js')], { stdio: 'inherit', env: { ...process.env, CDP_INSTALL_DIR: appDir }, windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`The installer failed (${r.error ? r.error.message : `exit ${r.status}`}) – see its output above. config.json and the Application ID were not touched.`);
    return { status: 'updated', label: target.label, version: target.version || null };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { unpackCommand, update, download, resolveTarget };
