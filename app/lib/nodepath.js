'use strict';
// Absolute path of the Node binary written into the hooks and the LaunchAgent.
// Hooks and launchd do not get the terminal's PATH (the Claude desktop app and launchd
// start with a minimal one), so a bare `node` is never used.
//
// process.execPath is the resolved binary. With Homebrew that is a versioned Cellar path
// (/opt/homebrew/Cellar/node/22.1.0/bin/node) which disappears on `brew upgrade`; the
// stable links /opt/homebrew/bin/node or /opt/homebrew/opt/<formula>/bin/node point to the
// same file and survive upgrades, so they are preferred when they resolve to it.
// Version managers (nvm, fnm, volta, asdf, mise) keep a per-version path – it is used as
// is; re-run the installer after switching or removing that Node version.
const fs = require('fs');
const path = require('path');

function stableNodePath(execPath = process.execPath, { realpath = p => fs.realpathSync(p), platform = process.platform } = {}) {
  if (platform === 'win32') return execPath;
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!m) return execPath;
  let real; try { real = realpath(execPath); } catch { return execPath; }
  for (const c of [path.posix.join(m[1], 'opt', m[2], 'bin', 'node'), path.posix.join(m[1], 'bin', 'node')]) {
    try { if (realpath(c) === real) return c; } catch {}
  }
  return execPath;
}

module.exports = { stableNodePath };
