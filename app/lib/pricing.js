'use strict';
// Estimated cost at Anthropic first-party API list prices (USD per million tokens).
// The price table lives in app/pricing.json; the background process refreshes it from the
// repository once a day (see daemon.js), so a new model gets a price without a new release.
// Claude Code subscriptions (Pro/Max) are NOT billed per token – for them this is the
// API-equivalent value, not money actually charged.
//
// Columns: input, output, cache write 5 min (w5), cache write 1 h (w1), cache read.
const fs = require('fs');
const path = require('path');

const P = (input, output, read, w5 = input * 1.25, w1 = input * 2) => ({ input, output, w5, w1, read });
const PRICE_KEYS = ['input', 'output', 'w5', 'w1', 'read'];

// Validates a pricing.json document; returns { date, table } or throws. Only plain numbers
// within a sane range and simple model prefixes are accepted – the file is data, never code.
function parsePricing(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models) || !doc.models.length || doc.models.length > 500) throw new Error('pricing: no model list');
  const table = [];
  for (const row of doc.models) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !/^[a-z0-9][a-z0-9.\-]{1,80}$/.test(row[0])) throw new Error('pricing: bad model prefix');
    const v = row[1] || {};
    for (const k of PRICE_KEYS) if (typeof v[k] !== 'number' || !Number.isFinite(v[k]) || v[k] < 0 || v[k] > 10000) throw new Error(`pricing: bad ${k} for ${row[0]}`);
    table.push([row[0], P(v.input, v.output, v.read, v.w5, v.w1)]);
  }
  const date = typeof doc.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.date) ? doc.date : null;
  return { date, table };
}

const bundled = parsePricing(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pricing.json'), 'utf8')));
let current = bundled;

// Use a newer table (e.g. fetched from the repository). Returns true when applied.
function setPricing(doc) {
  const p = parsePricing(doc);
  if (bundled.date && p.date && p.date < bundled.date) return false; // never older than the installed table
  current = p;
  return true;
}
function pricesDate() { return current.date; }

function priceFor(model, overrides) {
  if (!model) return null;
  const id = String(model).toLowerCase().replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '').replace(/\[.*\]$/, '');
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) if (id.startsWith(k.toLowerCase()) && v && Number.isFinite(v.input)) {
      return P(v.input, v.output, v.read ?? v.input * 0.1, v.w5 ?? v.input * 1.25, v.w1 ?? v.input * 2);
    }
  }
  for (const [prefix, p] of current.table) if (id.startsWith(prefix)) return p;
  return null;
}

// m: { model, speed, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, c5m, c1h } }
// Returns USD or null when the model is unknown.
function costOf(m, overrides) {
  const p = priceFor(m.model, overrides);
  if (!p) return null;
  const u = m.usage;
  let w5 = u.c5m, w1 = u.c1h;
  if (!(w5 + w1)) { w5 = u.cache_creation_input_tokens; w1 = 0; } // no TTL breakdown → 5-minute price
  const mult = m.speed === 'fast' ? 2 : 1; // fast mode = 2× standard price
  return mult * (u.input_tokens * p.input + u.output_tokens * p.output + w5 * p.w5 + w1 * p.w1 + u.cache_read_input_tokens * p.read) / 1e6;
}

function formatCost(usd, lang = 'en') {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  let s;
  if (usd < 0.005) s = usd === 0 ? '0.00' : '<0.01';
  else if (usd < 1000) s = usd.toFixed(2);
  else s = (usd / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (lang === 'pl') s = s.replace('.', ',');
  return s.startsWith('<') ? `<$${s.slice(1)}` : `$${s}`;
}

// kept for compatibility (the bundled table's date)
const PRICES_DATE = bundled.date;

module.exports = { PRICES_DATE, pricesDate, priceFor, costOf, formatCost, parsePricing, setPricing };
