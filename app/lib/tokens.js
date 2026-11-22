'use strict';
// Zliczanie rzeczywistego zużycia tokenów z lokalnych transkryptów JSONL Claude Code.
//
// Źródło: rekordy {"type":"assistant","message":{"id":"msg_…","usage":{…}}}.
// Claude Code zapisuje jedną linię na każdy blok treści odpowiedzi (thinking,
// text, tool_use) – każda niesie TEN SAM obiekt usage tego samego message.id.
// Dlatego zużycie jest kluczowane po message.id i liczone dokładnie raz.
// Subagenci mają własne pliki <sesja>/subagents/agent-*.jsonl z własnymi message.id.
const fs = require('fs');
const path = require('path');
const { costOf } = require('./pricing');

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

function num(v) { return Number.isFinite(v) && v > 0 ? v : 0; }

class FileTail {
  constructor(file, kind) {
    this.file = file; this.kind = kind; // 'main' | 'subagent'
    this.offset = 0; this.partial = Buffer.alloc(0); this.ino = null;
    this.lines = 0; this.badLines = 0; this.exists = false;
  }
  // Zwraca tablicę kompletnych linii dopisanych od ostatniego odczytu.
  // reset=true oznacza, że plik został przepisany/obcięty (trzeba usunąć jego wkład).
  poll() {
    let st;
    try { st = fs.statSync(this.file); } catch { this.exists = false; return { lines: [], reset: false }; }
    this.exists = true;
    let reset = false;
    const ino = `${st.ino}:${st.dev}`;
    if (st.size < this.offset || (this.ino && this.ino !== ino && st.ino !== 0)) {
      reset = true; this.offset = 0; this.partial = Buffer.alloc(0);
    }
    this.ino = ino;
    if (st.size === this.offset) return { lines: [], reset };
    const fd = fs.openSync(this.file, 'r');
    try {
      const out = [];
      const CHUNK = 1 << 20;
      const buf = Buffer.allocUnsafe(CHUNK);
      let pending = this.partial;
      while (this.offset < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        let data = Buffer.concat([pending, buf.subarray(0, n)]);
        let start = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] === 0x0a) { out.push(data.toString('utf8', start, i)); start = i + 1; }
        }
        pending = Buffer.from(data.subarray(start)); // niedokończona linia – czekamy na resztę
      }
      this.partial = pending;
      this.lines += out.length;
      return { lines: out, reset };
    } finally { fs.closeSync(fd); }
  }
}

class SessionUsage {
  // transcriptPath: ścieżka JSONL wskazana przez Claude Code w danych hooka.
  constructor(transcriptPath, sessionId, opts = {}) {
    this.transcriptPath = transcriptPath;
    this.sessionId = sessionId;
    this.includeSubagents = opts.includeSubagents !== false;
    this.tails = new Map();
    this.messages = new Map(); // message.id -> {ts, file, usage, kind}
    this.duplicateLines = 0;
    this.compactions = 0;
    if (transcriptPath) this.tails.set(transcriptPath, new FileTail(transcriptPath, 'main'));
  }

  subagentDir() {
    if (!this.transcriptPath) return null;
    const dir = path.dirname(this.transcriptPath);
    const base = path.basename(this.transcriptPath, '.jsonl');
    return path.join(dir, base, 'subagents');
  }

  discover() {
    if (!this.includeSubagents) return;
    const d = this.subagentDir();
    if (!d) return;
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(d, n);
      if (!this.tails.has(f)) this.tails.set(f, new FileTail(f, 'subagent'));
    }
  }

  poll() {
    this.discover();
    for (const tail of this.tails.values()) {
      let res;
      try { res = tail.poll(); } catch { continue; }
      if (res.reset) for (const [id, m] of this.messages) if (m.file === tail.file) this.messages.delete(id);
      for (const line of res.lines) this.ingest(line, tail);
    }
  }

  ingest(line, tail) {
    if (!line || line.indexOf('"usage"') === -1) {
      if (line && line.indexOf('"compact_boundary"') !== -1) this.compactions++;
      return;
    }
    let o;
    try { o = JSON.parse(line); } catch { tail.badLines++; return; }
    if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) return;
    const m = o.message;
    if (m.model === '<synthetic>') return;
    const id = m.id || o.requestId || o.uuid;
    if (!id) return;
    const u = {};
    for (const f of FIELDS) u[f] = num(m.usage[f]);
    const cc = m.usage.cache_creation || {};
    u.c5m = num(cc.ephemeral_5m_input_tokens); u.c1h = num(cc.ephemeral_1h_input_tokens);
    const speed = m.usage.speed || o.speed || null;
    const ts = Date.parse(o.timestamp) || 0;
    const prev = this.messages.get(id);
    if (prev) {
      this.duplicateLines++;
      // rekord zaktualizowany (np. dłuższy output) – bierzemy największe wartości, nie sumę
      for (const f of [...FIELDS, 'c5m', 'c1h']) prev.usage[f] = Math.max(prev.usage[f], u[f]);
      if (!prev.model && m.model) prev.model = m.model;
      prev.ts = Math.min(prev.ts || ts, ts || prev.ts);
      return;
    }
    this.messages.set(id, { ts, file: tail.file, usage: u, kind: tail.kind, model: m.model || null, speed });
  }

  get hasSource() {
    const main = this.tails.get(this.transcriptPath);
    return !!(main && main.exists);
  }
}

// Sumuje wiele SessionUsage (np. /clear w tym samym procesie) z deduplikacją po message.id.
function aggregate(usages, sinceMs, priceOverrides) {
  const seen = new Map();
  for (const su of usages) for (const [id, m] of su.messages) if (!seen.has(id)) seen.set(id, m);
  const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, messages: 0, subagentMessages: 0, costUsd: 0, unpricedMessages: 0, unpricedModels: [], models: {} });
  const launch = blank(), all = blank();
  const add = (t, m) => {
    t.input += m.usage.input_tokens; t.output += m.usage.output_tokens;
    t.cacheRead += m.usage.cache_read_input_tokens; t.cacheCreation += m.usage.cache_creation_input_tokens;
    t.messages++; if (m.kind === 'subagent') t.subagentMessages++;
    const c = costOf(m, priceOverrides);
    const key = m.model || 'unknown';
    if (c === null) { t.unpricedMessages++; if (!t.unpricedModels.includes(key)) t.unpricedModels.push(key); }
    else { t.costUsd += c; t.models[key] = (t.models[key] || 0) + c; }
  };
  for (const m of seen.values()) {
    add(all, m);
    if (!sinceMs || m.ts >= sinceMs) add(launch, m);
  }
  return { sinceLaunch: launch, conversation: all };
}

// Definicja licznika publikowanego na Discordzie.
function countFor(t, mode) {
  if (mode === 'output') return t.output;
  if (mode === 'no_cache_read') return t.input + t.cacheCreation + t.output;
  return t.input + t.cacheCreation + t.cacheRead + t.output; // 'all'
}

module.exports = { FileTail, SessionUsage, aggregate, countFor };
