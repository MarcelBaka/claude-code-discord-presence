'use strict';
// "Today" totals across ALL Claude Code sessions (every project, finished sessions too):
// every transcript under ~/.claude/projects changed since local midnight is read
// incrementally; API responses are deduplicated by message.id and counted when their
// timestamp is today (local time).
const fs = require('fs');
const path = require('path');
const { SessionUsage, aggregate } = require('./tokens');

function localMidnight(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}

class DailyUsage {
  constructor(projectsDir, opts = {}) {
    this.dir = projectsDir;
    this.includeSubagents = opts.includeSubagents !== false;
    this.files = new Map(); // main transcript path -> SessionUsage
    this.day = localMidnight();
    this.lastScan = 0;
    this.result = null;
  }

  scan() {
    const midnight = localMidnight();
    if (midnight !== this.day) { this.day = midnight; this.files.clear(); }
    let projects = [];
    try { projects = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return; }
    for (const p of projects) {
      const pdir = path.join(this.dir, p.name);
      let names = [];
      try { names = fs.readdirSync(pdir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(pdir, n);
        if (this.files.has(f)) continue;
        let st; try { st = fs.statSync(f); } catch { continue; }
        // subagent transcripts change without touching the main file – check the folder too
        let recent = st.mtimeMs >= midnight;
        if (!recent) { try { recent = fs.statSync(path.join(pdir, n.slice(0, -6), 'subagents')).mtimeMs >= midnight; } catch {} }
        if (recent) this.files.set(f, new SessionUsage(f, n.slice(0, -6), { includeSubagents: this.includeSubagents }));
      }
    }
  }

  // Returns totals for today; rescans for new files at most every `scanEveryMs`.
  totals(priceOverrides, scanEveryMs = 60000) {
    if (Date.now() - this.lastScan >= scanEveryMs || localMidnight() !== this.day) { this.scan(); this.lastScan = Date.now(); }
    const usages = [...this.files.values()];
    for (const u of usages) { try { u.poll(); } catch {} }
    const agg = aggregate(usages, this.day, priceOverrides);
    this.result = { since: new Date(this.day).toISOString(), files: usages.length, ...agg.sinceLaunch };
    return this.result;
  }
}

module.exports = { DailyUsage, localMidnight };
