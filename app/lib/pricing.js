'use strict';
// Estimated cost at Anthropic first-party API list prices (USD per million tokens).
// Source: Claude API model/pricing documentation bundled with Claude Code 2.1.330
// (cached 2026-11-03). Claude Code subscriptions (Pro/Max) are NOT billed per token –
// for them this is the API-equivalent value, not money actually charged.
//
// Columns: input, output, cache write 5 min, cache write 1 h, cache read.
// Cache writes are 1.25× (5 min) and 2× (1 h) of input; cache reads vary by model.
const PRICES_DATE = '2026-11-03';
const P = (input, output, read, w5 = input * 1.25, w1 = input * 2) => ({ input, output, w5, w1, read });

const TABLE = [
  // most specific prefixes first
  ['claude-fable-5-2', P(8, 40, 0.20, 10, 16)],
  ['claude-mythos-5-2', P(8, 40, 0.20, 10, 16)],
  ['claude-fable-5-1', P(10, 50, 0.25)],
  ['claude-mythos-5-1', P(10, 50, 0.25)],
  ['claude-fable-5', P(10, 50, 1.00)],
  ['claude-mythos-5', P(10, 50, 1.00)],
  ['claude-opus-5-5', P(4, 20, 0.20, 5, 8)],
  ['claude-opus-5', P(5, 25, 0.50)],
  ['claude-opus-4-8', P(5, 25, 0.50)],
  ['claude-opus-4-7', P(5, 25, 0.50)],
  ['claude-opus-4-6', P(5, 25, 0.50)],
  ['claude-opus-4-5', P(5, 25, 0.50)],
  ['claude-sonnet-5-5', P(2, 10, 0.10, 2.5, 4)],
  ['claude-sonnet-5', P(2, 10, 0.20, 2.5, 4)],
  ['claude-sonnet-4', P(3, 15, 0.30)],        // 4, 4.5, 4.6
  ['claude-haiku-5-5', P(0.10, 0.50, 0.01)],  // prompts ≤100K tokens (longer prompts cost more – not modelled)
  ['claude-haiku-4-5', P(1, 5, 0.10)],
];

function priceFor(model, overrides) {
  if (!model) return null;
  const id = String(model).toLowerCase().replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '').replace(/\[.*\]$/, '');
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) if (id.startsWith(k.toLowerCase()) && v && Number.isFinite(v.input)) {
      return P(v.input, v.output, v.read ?? v.input * 0.1, v.w5 ?? v.input * 1.25, v.w1 ?? v.input * 2);
    }
  }
  for (const [prefix, p] of TABLE) if (id.startsWith(prefix)) return p;
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

module.exports = { PRICES_DATE, priceFor, costOf, formatCost };
