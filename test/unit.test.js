'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-unit-'));
process.env.CDP_DATA_DIR = path.join(tmp, 'data');
const { SessionUsage, aggregate, countFor } = require('../app/lib/tokens');
const { formatTokens } = require('../app/lib/common');
const { findProjectRoot, displayName } = require('../app/lib/project');
const S = require('../app/lib/settings');

const asst = (id, ts, u, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'req_' + id, uuid: Math.random().toString(36), message: { id, model: 'claude-x', content: [{ type: 'text', text: 'treść której nie wolno liczyć' }], usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } }, ...extra });

test('formatowanie liczb', () => {
  assert.strictEqual(formatTokens(0), '0');
  assert.strictEqual(formatTokens(999), '999');
  assert.strictEqual(formatTokens(12400), '12,4 tys.');
  assert.strictEqual(formatTokens(125400), '125,4 tys.');
  assert.strictEqual(formatTokens(12000), '12 tys.');
  assert.strictEqual(formatTokens(1250000), '1,25 mln');
  assert.strictEqual(formatTokens(999990), '1 mln');
  assert.strictEqual(formatTokens(108412206), '108,41 mln');
  assert.strictEqual(formatTokens(null), null);
});

test('tokeny: deduplikacja bloków, częściowa linia, filtr uruchomienia, subagenci, cache osobno', () => {
  const dir = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(dir, 'sess1', 'subagents'), { recursive: true });
  const f = path.join(dir, 'sess1.jsonl');
  const launch = Date.parse('2026-11-22T10:00:00Z');
  fs.writeFileSync(f, [
    asst('msg_old', '2026-11-22T09:00:00Z', [5, 50, 1000, 100]),            // historia wznowionej rozmowy
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 999999 } }),
    asst('msg_a', '2026-11-22T10:01:00Z', [2, 30, 5000, 200]),              // blok thinking
    asst('msg_a', '2026-11-22T10:01:01Z', [2, 30, 5000, 200]),              // blok tool_use – ten sam message.id
    asst('msg_a', '2026-11-22T10:01:02Z', [2, 40, 5000, 200]),              // zaktualizowany rekord
    JSON.stringify({ type: 'user', message: { content: 'prompt' } }),
    '{"type":"assistant","message":{"id":"msg_b","usage":{"input_tok', // częściowo zapisana linia
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-1.jsonl'), asst('msg_sub', '2026-11-22T10:02:00Z', [1, 10, 300, 20]) + '\n');

  const su = new SessionUsage(f, 'sess1');
  su.poll();
  let a = aggregate([su], launch);
  const pick = ({ input, output, cacheRead, cacheCreation, messages, subagentMessages }) => ({ input, output, cacheRead, cacheCreation, messages, subagentMessages });
  assert.deepStrictEqual(pick(a.sinceLaunch), { input: 3, output: 50, cacheRead: 5300, cacheCreation: 220, messages: 2, subagentMessages: 1 });
  assert.strictEqual(a.conversation.messages, 3);
  assert.strictEqual(su.compactions, 1);
  assert.strictEqual(su.duplicateLines, 2);

  // dokończenie linii + nowa wiadomość; ponowny odczyt nie nalicza starych drugi raz
  fs.appendFileSync(f, 'ens":7,"output_tokens":70,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"timestamp":"2026-11-22T10:03:00Z"}\n');
  su.poll(); su.poll();
  a = aggregate([su], launch);
  assert.strictEqual(a.sinceLaunch.input, 10);
  assert.strictEqual(a.sinceLaunch.output, 120);
  assert.strictEqual(countFor(a.sinceLaunch, 'all'), 10 + 120 + 5300 + 220);
  assert.strictEqual(countFor(a.sinceLaunch, 'no_cache_read'), 10 + 120 + 220);
  assert.strictEqual(countFor(a.sinceLaunch, 'output'), 120);

  // ta sama odpowiedź w drugim pliku (np. wznowienie/fork kopiujące historię) liczona raz
  const f2 = path.join(dir, 'sess2.jsonl');
  fs.writeFileSync(f2, asst('msg_a', '2026-11-22T10:01:00Z', [2, 40, 5000, 200]) + '\n' + asst('msg_c', '2026-11-22T10:05:00Z', [1, 1, 1, 1]) + '\n');
  const su2 = new SessionUsage(f2, 'sess2');
  su2.poll();
  a = aggregate([su, su2], launch);
  assert.strictEqual(a.sinceLaunch.messages, 4); // msg_a, msg_sub, msg_b, msg_c (msg_a z drugiego pliku pominięty)
  assert.strictEqual(a.sinceLaunch.output, 121);

  // przepisany (obcięty) plik – wkład resetowany, nie dublowany
  fs.writeFileSync(f2, asst('msg_c', '2026-11-22T10:05:00Z', [1, 1, 1, 1]) + '\n');
  su2.poll();
  assert.strictEqual(su2.messages.size, 1);
});

test('tokeny: brak transkryptu = brak danych (nie zero)', () => {
  const su = new SessionUsage(path.join(tmp, 'nie-ma.jsonl'), 'x');
  su.poll();
  assert.strictEqual(su.hasSource, false);
});

test('projekt: korzeń git, worktree, spacje i polskie znaki, alias, ukrywanie', () => {
  const repo = path.join(tmp, 'Mój projekt żółć');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.strictEqual(findProjectRoot(path.join(repo, 'src', 'deep')).root, repo);
  const wt = path.join(repo, '.claude', 'worktrees', 'feature-x');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'feature-x'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feature-x')}\n`);
  assert.strictEqual(findProjectRoot(wt).root, repo);
  const plain = path.join(tmp, 'bez gita');
  fs.mkdirSync(plain);
  assert.strictEqual(findProjectRoot(plain).git, false);

  const cfg = { aliases: {}, hiddenProjects: [], hideProject: false };
  assert.strictEqual(displayName(repo, cfg), 'Mój projekt żółć');
  assert.strictEqual(displayName(repo, { ...cfg, aliases: { 'Mój projekt żółć': 'Zażółć gęślą jaźń' } }), 'Zażółć gęślą jaźń');
  assert.strictEqual(displayName(repo, { ...cfg, aliases: { [repo]: 'Po ścieżce' } }), 'Po ścieżce');
  assert.strictEqual(displayName(repo, { ...cfg, hideProject: true }), null);
  assert.strictEqual(displayName(repo, { ...cfg, hiddenProjects: ['Mój projekt żółć'] }), null);
  assert.ok(!displayName(repo, cfg).includes(path.sep));
});

test('settings.json: zachowanie istniejących hooków i statusLine, idempotencja, deinstalacja', () => {
  const orig = {
    theme: 'dark',
    statusLine: { type: 'command', command: 'my-status.sh' },
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo istniejący' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] }],
    },
  };
  const once = S.addOurs(orig, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\x\\.claude\\discord-presence\\hook.js');
  const twice = S.addOurs(once, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\x\\.claude\\discord-presence\\hook.js');
  assert.deepStrictEqual(twice, once);
  assert.strictEqual(S.countOurs(twice), 4);
  assert.deepStrictEqual(twice.statusLine, orig.statusLine);
  assert.deepStrictEqual(twice.hooks.PreToolUse, orig.hooks.PreToolUse);
  assert.deepStrictEqual(twice.hooks.SessionStart[0], orig.hooks.SessionStart[0]);
  assert.match(twice.hooks.SessionStart[1].hooks[0].command, /^"C:\/Program Files\/nodejs\/node.exe" "C:\/Users\/x\/.claude\/discord-presence\/hook.js" SessionStart$/);
  assert.deepStrictEqual(S.stripOurs(twice), orig);
  assert.deepStrictEqual(S.stripOurs(S.addOurs({}, 'n', '/a/discord-presence/hook.js')), {});
});

test('English formatting and strings', () => {
  const { strings } = require('../app/lib/common');
  assert.strictEqual(formatTokens(999, 'en'), '999');
  assert.strictEqual(formatTokens(12400, 'en'), '12.4k');
  assert.strictEqual(formatTokens(12000, 'en'), '12k');
  assert.strictEqual(formatTokens(1250000, 'en'), '1.25M');
  assert.strictEqual(formatTokens(3.2e9, 'en'), '3.2B');
  assert.strictEqual(strings('en').noData, 'Tokens: no data');
  assert.strictEqual(strings('xx').project, 'Project');
});

test('cost: list prices per model, cache TTL split, fast mode, unknown models, formatting', () => {
  const { costOf, formatCost, priceFor } = require('../app/lib/pricing');
  const u = (i, o, r, c, c5 = 0, c1 = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: c, c5m: c5, c1h: c1 });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  // Opus 5.5: $4 in, $20 out, $5 write 5m, $8 write 1h, $0.20 read
  near(costOf({ model: 'claude-opus-5-5', usage: u(1e6, 1e6, 1e6, 2e6, 1e6, 1e6) }), 4 + 20 + 0.2 + 5 + 8);
  near(costOf({ model: 'claude-opus-5-5', usage: u(0, 0, 0, 1e6) }), 5);              // no TTL breakdown → 5 min price
  near(costOf({ model: 'claude-opus-5-5', speed: 'fast', usage: u(1e6, 1e6, 0, 0) }), 48); // fast = 2×
  near(costOf({ model: 'claude-sonnet-5-5', usage: u(1e6, 1e6, 1e6, 0) }), 2 + 10 + 0.1);
  near(costOf({ model: 'claude-haiku-5-5', usage: u(1e6, 1e6, 0, 0) }), 0.6);
  near(costOf({ model: 'claude-fable-5-2', usage: u(0, 0, 0, 1e6, 0, 1e6) }), 16);
  near(costOf({ model: 'claude-sonnet-4-6', usage: u(1e6, 0, 0, 0) }), 3);
  assert.strictEqual(priceFor('claude-sonnet-5').read, 0.2);
  assert.strictEqual(costOf({ model: 'gpt-x', usage: u(1, 1, 1, 1) }), null);
  assert.strictEqual(costOf({ model: null, usage: u(1, 1, 1, 1) }), null);
  near(costOf({ model: 'my-model', usage: u(1e6, 0, 0, 0) }, { 'my-model': { input: 7, output: 9 } }), 7);
  assert.strictEqual(formatCost(7.5335), '$7.53');
  assert.strictEqual(formatCost(7.5335, 'pl'), '$7,53');
  assert.strictEqual(formatCost(0.001), '<$0.01');
  assert.strictEqual(formatCost(1234), '$1.2k');
  assert.strictEqual(formatCost(null), null);
});

test('cost: aggregate sums per model once per message.id and flags unknown models', () => {
  const dir = path.join(tmp, 'cost'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's.jsonl');
  const line = (id, model) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-22T10:00:00Z', message: { id, model, usage: { input_tokens: 0, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  fs.writeFileSync(f, [line('m1', 'claude-opus-5-5'), line('m1', 'claude-opus-5-5'), line('m2', 'claude-haiku-5-5'), line('m3', 'mystery')].join('\n') + '\n');
  const su = new SessionUsage(f, 's'); su.poll();
  const t = aggregate([su], 0).conversation;
  assert.ok(Math.abs(t.costUsd - 20.5) < 1e-9);
  assert.strictEqual(t.unpricedMessages, 1);
  assert.deepStrictEqual(t.unpricedModels, ['mystery']);
});
