'use strict';
// Ustalanie nazwy projektu: katalog główny repozytorium Git (także dla worktree),
// a poza repozytorium – katalog roboczy. Do Discorda trafia wyłącznie nazwa/alias.
const fs = require('fs');
const path = require('path');

function findProjectRoot(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const git = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(git); } catch {}
    if (st && st.isDirectory()) return { root: dir, git: true };
    if (st && st.isFile()) {
      // worktree / submodule: "gitdir: <repo>/.git/worktrees/<nazwa>"
      try {
        const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(git, 'utf8'));
        if (m) {
          const gd = path.resolve(dir, m[1].trim());
          const parts = gd.split(/[\\/]/);
          const idx = parts.lastIndexOf('worktrees');
          if (idx > 0 && parts[idx - 1] === '.git') return { root: parts.slice(0, idx - 1).join(path.sep) || dir, git: true, worktree: dir };
        }
      } catch {}
      return { root: dir, git: true };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: path.resolve(cwd), git: false };
}

function norm(p) { return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase(); }

// Zwraca to, co może trafić do Discorda (albo null, gdy projekt ukryty).
function displayName(projectRoot, cfg) {
  if (!projectRoot) return null;
  const base = path.basename(projectRoot) || projectRoot;
  const aliases = cfg.aliases || {};
  let alias = null;
  for (const [k, v] of Object.entries(aliases)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    if (k === base || k.toLowerCase() === base.toLowerCase()) alias = alias || v.trim();
    if ((k.includes('/') || k.includes('\\')) && norm(k) === norm(projectRoot)) { alias = v.trim(); break; }
  }
  const hidden = cfg.hideProject || (cfg.hiddenProjects || []).some(h =>
    typeof h === 'string' && (h.toLowerCase() === base.toLowerCase() || ((h.includes('/') || h.includes('\\')) && norm(h) === norm(projectRoot)) || (alias && h === alias)));
  if (hidden) return null;
  return (alias || base).normalize('NFC').slice(0, 100);
}

module.exports = { findProjectRoot, displayName };
