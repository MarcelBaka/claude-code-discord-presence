'use strict';
// `cli.js update`: download the repository's main branch ZIP, unpack it with a system tool
// and rerun its installer into the current install directory (config.json, the
// Application ID and state stay – the installer never overwrites them).
// Every external tool gets its arguments as an array (execFile/spawnSync, no shell string).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Which system tool unpacks the ZIP on this platform.
function unpackCommand(zip, outDir, platform = process.platform) {
  if (platform === 'win32') {
    // paths go in as arguments ($args), not spliced into the script text
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '& { Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force }', zip, outDir] };
  }
  if (platform === 'darwin') return { cmd: '/usr/bin/ditto', args: ['-x', '-k', zip, outDir] };
  return { cmd: 'unzip', args: ['-q', '-o', zip, '-d', outDir] };
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

// Throws on any failure; the temporary directory is removed in every case.
async function update({ repo, appDir, platform = process.platform, fetch = download, log = console.log, nodePath = process.execPath, run = spawnSync }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('updateRepo in config.json must look like "owner/name".');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-update-'));
  try {
    const zip = path.join(tmp, 'source.zip');
    log(`Downloading https://github.com/${repo} (main)…`);
    await fetch(`https://codeload.github.com/${repo}/zip/refs/heads/main`, zip);
    const head = Buffer.alloc(4);
    const fd = fs.openSync(zip, 'r'); try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('The download is not a ZIP archive.');
    const outDir = path.join(tmp, 'x');
    fs.mkdirSync(outDir);
    const u = unpackCommand(zip, outDir, platform);
    const ex = run(u.cmd, u.args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (ex.error || ex.status !== 0) throw new Error(`Could not unpack the download (${u.cmd}): ${(ex.error && ex.error.message) || (ex.stderr || '').trim() || `exit ${ex.status}`}`);
    // GitHub ZIPs have one top folder (<repo>-main/); accept a flat archive too
    const top = [outDir, ...fs.readdirSync(outDir).map(n => path.join(outDir, n))].find(d => fs.existsSync(path.join(d, 'install.js')));
    if (!top) throw new Error('The download does not contain install.js.');
    const r = run(nodePath, [path.join(top, 'install.js')], { stdio: 'inherit', env: { ...process.env, CDP_INSTALL_DIR: appDir }, windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`The installer failed (${r.error ? r.error.message : `exit ${r.status}`}) – see its output above. config.json and the Application ID were not touched.`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { unpackCommand, update, download };
