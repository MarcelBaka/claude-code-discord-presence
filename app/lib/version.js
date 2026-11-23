'use strict';
// Installed version (app/version.json), comparison with the latest GitHub release and a
// once-a-day cached check. The check only sends an anonymous request to the public GitHub
// API (no token, no data about you or your sessions); turn it off with checkUpdates: false.
const fs = require('fs');
const path = require('path');

function installedVersion(appDir = path.resolve(__dirname, '..')) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, 'version.json'), 'utf8')).version || null; } catch { return null; }
}

// 1.2.3 / v1.2.3 / 1.2.3-beta.1 → comparable parts; null when not a version
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(v || '').trim());
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] || null } : null;
}

// <0 when a is older than b, 0 equal, >0 newer; a pre-release is older than its release
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { headers: { 'User-Agent': 'claude-code-discord-presence', Accept: 'application/vnd.github+json' }, timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if (res.statusCode === 404) return reject(Object.assign(new Error('no published release'), { code: 'NO_RELEASE' }));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from GitHub`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
  });
}

// Latest published (non-draft, non-prerelease) release: { tag, version, url, publishedAt }
async function latestRelease(repo, fetchJson = getJson) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('updateRepo in config.json must look like "owner/name".');
  const j = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const tag = j && typeof j.tag_name === 'string' ? j.tag_name : null;
  if (!tag || !parse(tag)) throw new Error('the latest release has no version tag');
  return { tag, version: tag.replace(/^v/, ''), url: typeof j.html_url === 'string' ? j.html_url : `https://github.com/${repo}/releases/tag/${tag}`, publishedAt: j.published_at || null };
}

// Cached check (state/update-check.json), at most once per `maxAgeMs`.
async function checkForUpdate({ repo, cacheFile, installed = installedVersion(), maxAgeMs = 24 * 3600e3, fetchJson = getJson, now = Date.now(), force = false }) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  if (!force && cache && cache.repo === repo && now - (cache.checkedAt || 0) < maxAgeMs) return summarize(cache, installed);
  const next = { repo, checkedAt: now, latest: null, url: null, error: null };
  try { const r = await latestRelease(repo, fetchJson); next.latest = r.version; next.url = r.url; }
  catch (e) { next.error = e.message; if (cache && cache.repo === repo) { next.latest = cache.latest; next.url = cache.url; } }
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(next, null, 2) + '\n'); } catch {}
  return summarize(next, installed);
}

function summarize(c, installed) {
  const newer = c.latest && installed ? compare(c.latest, installed) > 0 : false;
  return { installed, latest: c.latest || null, url: c.url || null, checkedAt: c.checkedAt || null, error: c.error || null, updateAvailable: !!newer };
}

module.exports = { installedVersion, parse, compare, latestRelease, checkForUpdate, getJson };
