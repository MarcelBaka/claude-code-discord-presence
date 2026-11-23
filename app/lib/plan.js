'use strict';
// Which Claude subscription is signed in to Claude Code (Pro, Max 5x/20x, Team, Enterprise).
// Read from ~/.claude.json → oauthAccount (organizationType and the rate-limit tier) – the
// plain settings file. The credentials file with the tokens is never opened. Only the plan's
// name leaves this module; nothing else from the account (e-mail, billing, dates).
const fs = require('fs');
const os = require('os');
const path = require('path');

function claudeJsonPath() { return process.env.CDP_CLAUDE_JSON || path.join(os.homedir(), '.claude.json'); }

// organizationType "claude_max" + tier "default_claude_max_20x" → "Claude Max 20x"
function planLabel(account) {
  if (!account || typeof account !== 'object') return null;
  const type = String(account.organizationType || '').toLowerCase().trim();
  if (!/^claude_[a-z0-9_]{2,30}$/.test(type)) return null;
  const tiers = [account.userRateLimitTier, account.organizationRateLimitTier, account.seatTier].filter(t => typeof t === 'string').join(' ').toLowerCase();
  const name = type.slice('claude_'.length);
  const known = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  let label = known[name] || name.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  if (name === 'max') { const m = /\b(?:max_)?(5|20)x\b/.exec(tiers.replace(/_/g, ' ').replace(/ (5|20) x/, ' $1x')); if (m) label += ` ${m[1]}x`; }
  return `Claude ${label}`;
}

let cache = { at: 0, mtime: null, label: null };
// Cached; re-read at most once a minute, or when the file changed.
function currentPlan(now = Date.now()) {
  const f = claudeJsonPath();
  let mtime = null;
  try { mtime = fs.statSync(f).mtimeMs; } catch { cache = { at: now, mtime: null, label: null }; return null; }
  if (cache.mtime === mtime && now - cache.at < 60000) return cache.label;
  let label = null;
  try { label = planLabel(JSON.parse(fs.readFileSync(f, 'utf8')).oauthAccount); } catch { label = cache.label; } // mid-write → keep the last one
  cache = { at: now, mtime, label };
  return label;
}

module.exports = { planLabel, currentPlan, claudeJsonPath };
