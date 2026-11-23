'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-unit-'));
process.env.CDP_DATA_DIR = path.join(tmp, 'data');
// never touch the real Startup folder / ~/Library/LaunchAgents / launchd from tests
const SANDBOX = { CDP_STARTUP_DIR: path.join(tmp, 'sandbox-startup'), CDP_LAUNCH_AGENTS_DIR: path.join(tmp, 'sandbox-agents'), CDP_LAUNCHCTL: 'none' };
Object.assign(process.env, SANDBOX);
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
  const once = S.addOurs(orig, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\x\\.claude\\discord-presence\\hook.js', 'win32');
  const twice = S.addOurs(once, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\x\\.claude\\discord-presence\\hook.js', 'win32');
  assert.deepStrictEqual(twice, once);
  assert.strictEqual(S.countOurs(twice), 6); // SessionStart, UserPromptSubmit, Stop, Notification, CwdChanged, SessionEnd
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

test('daily: only today, every project, dedup by message.id, subagents', () => {
  const { DailyUsage, localMidnight } = require('../app/lib/daily');
  const root = path.join(tmp, 'daily-projects');
  const mk = (proj, file, lines) => { fs.mkdirSync(path.join(root, proj), { recursive: true }); fs.writeFileSync(path.join(root, proj, file), lines.join('\n') + '\n'); };
  const today = new Date(Math.min(Date.now(), localMidnight() + 3600e3)).toISOString();
  const yesterday = new Date(localMidnight() - 3600e3).toISOString();
  const l = (id, ts, out) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  mk('a', 's1.jsonl', [l('x1', yesterday, 7), l('x2', today, 100), l('x2', today, 100)]);
  mk('b', 's2.jsonl', [l('x3', today, 20), l('x2', today, 100)]); // x2 copied (resume) - once
  fs.mkdirSync(path.join(root, 'b', 's2', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b', 's2', 'subagents', 'agent-1.jsonl'), l('x4', today, 3) + '\n');
  const d = new DailyUsage(root);
  const t = d.totals();
  assert.strictEqual(t.files, 2);
  assert.strictEqual(t.output, 123);
  assert.strictEqual(t.messages, 3);
  assert.strictEqual(t.subagentMessages, 1);
});

test('autostart: startup launcher written as UTF-16 VBS and removed', () => {
  process.env.CDP_STARTUP_DIR = path.join(tmp, 'Startup ż');
  const a = require('../app/lib/autostart');
  const W = { platform: 'win32' };
  const f = a.enable('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Zoë\\.claude\\discord-presence\\daemon.js', W);
  assert.ok(a.isEnabled(W));
  const buf = fs.readFileSync(f);
  assert.deepStrictEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
  const txt = buf.subarray(2).toString('utf16le');
  assert.ok(txt.includes('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Zoë\\.claude\\discord-presence\\daemon.js"" --standby", 0, False'), txt);
  assert.ok(a.disable(W));
  assert.ok(!a.isEnabled(W));
  Object.assign(process.env, SANDBOX);
});

test('cli link: reads the Git remote (ssh to https, credentials stripped)', () => {
  const { spawnSync } = require('child_process');
  const data = path.join(tmp, 'cli-data'); fs.mkdirSync(data, { recursive: true });
  const repo = path.join(tmp, 'site-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:someone/site-repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'app', 'cli.js'), ...a], { env: { ...process.env, CDP_DATA_DIR: data }, encoding: 'utf8' });
  assert.strictEqual(run('link', repo).status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).links, { 'site-repo': 'https://github.com/someone/site-repo' });
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://user:secret@github.com/someone/site-repo.git\n');
  assert.strictEqual(run('link', repo).status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).links['site-repo'], 'https://github.com/someone/site-repo');
  assert.notStrictEqual(run('link', 'x', 'http://insecure.example').status, 0);
});

// ---------------------------------------------------------------------------
// macOS / Unix support. Platform-specific cases are marked with { skip } and a reason;
// the pure logic (quoting, plist, parsers, state mapping) runs on every platform.
// ---------------------------------------------------------------------------
const { spawn, spawnSync, execFileSync } = require('child_process');
const POSIX = process.platform !== 'win32';
const ONLY_POSIX = POSIX ? false : 'Unix shell / sockets – Windows uses named pipes and Git Bash';
const ONLY_DARWIN = process.platform === 'darwin' ? false : 'macOS system tools (plutil, ditto)';
// awkward but legal path characters: space, apostrophe, quotes, $, `, !, backslash, &, ;, Unicode
const WEIRD = POSIX ? `Zoë's "dir" $HOME \`x\` !a & b; ż\\q` : `Zoë's dir $HOME & b; ż`;

test('hook command: POSIX single-quote escaping for every shell metacharacter', () => {
  assert.strictEqual(S.shQuote(`a'b`), `'a'\\''b'`);
  const cmd = S.commandFor('/opt/homebrew/bin/node', `/Users/o'brien/.claude/discord-presence/hook.js`, 'Stop', 'darwin');
  assert.strictEqual(cmd, `'/opt/homebrew/bin/node' '/Users/o'\\''brien/.claude/discord-presence/hook.js' Stop`);
  assert.ok(S.isOurs({ command: cmd }), 'marker still recognised after quoting');
  const d = S.addOurs({ statusLine: { type: 'command', command: 'x' } }, '/n', '/h/discord-presence/hook.js', 'darwin');
  assert.strictEqual(S.countOurs(d), 6);
  assert.deepStrictEqual(S.addOurs(d, '/n', '/h/discord-presence/hook.js', 'darwin'), d, 'idempotent');
});

test('hook command really runs through sh -c with an awkward install path', { skip: ONLY_POSIX }, () => {
  const dir = path.join(tmp, WEIRD, 'discord-presence');
  fs.mkdirSync(dir, { recursive: true });
  const hook = path.join(dir, 'hook.js');
  fs.writeFileSync(hook, "process.stdout.write(JSON.stringify(process.argv.slice(1)))");
  const r = spawnSync('/bin/sh', ['-c', S.commandFor(process.execPath, hook, 'SessionStart', process.platform)], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [hook, 'SessionStart']);
});

test('Discord IPC: socket directories on macOS/Linux, every env candidate, dedup, 10 indices', () => {
  const { candidateDirs, candidatePaths } = require('../app/lib/discord-ipc');
  // TMPDIR points somewhere wrong (e.g. inherited by launchd/hook) – the per-user dir and /tmp are still tried
  assert.deepStrictEqual(candidateDirs({ env: { TMPDIR: '/wrong/T/' }, platform: 'darwin', darwinTemp: '/var/folders/ab/cd/T/' }), ['/wrong/T', '/var/folders/ab/cd/T', '/tmp']);
  assert.deepStrictEqual(candidateDirs({ env: { TMPDIR: '/var/folders/ab/cd/T/', TMP: '/var/folders/ab/cd/T' }, platform: 'darwin', darwinTemp: '/var/folders/ab/cd/T/' }), ['/var/folders/ab/cd/T', '/tmp']);
  assert.deepStrictEqual(candidateDirs({ env: { XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: 'relative' }, platform: 'darwin', darwinTemp: null }), ['/run/user/1000', '/tmp']);
  const lin = candidateDirs({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform: 'linux' });
  assert.ok(lin.includes('/run/user/1000/app/com.discordapp.Discord') && lin.includes('/run/user/1000/snap.discord'));
  const ps = candidatePaths({ env: {}, platform: 'darwin', darwinTemp: '/var/folders/x/T' });
  assert.strictEqual(ps.length, 20);
  assert.strictEqual(ps[0], '/var/folders/x/T/discord-ipc-0');
  assert.strictEqual(ps[19], '/tmp/discord-ipc-9');
  assert.strictEqual(candidatePaths({ env: {}, platform: 'win32' })[3], '\\\\?\\pipe\\discord-ipc-3');
});

test('process table: ps parsing, Claude recognition, walking past the hook shell', () => {
  const P = require('../app/lib/proc');
  const t = P.parseLstart('Mon Nov 23 09:04:55 2026');
  assert.strictEqual(t, new Date(2026, 10, 23, 9, 4, 55).getTime());
  assert.strictEqual(P.parseLstart('Mon Nov 23 08:09:35 2026', true), Date.UTC(2026, 10, 23, 8, 9, 35));
  const table = P.parseTable([
    '    1     0 Mon Nov 23 09:00:00 2026     /sbin/launchd',
    '  359     1 Mon Nov 23 09:04:55 2026     /Applications/Claude.app/Contents/MacOS/Claude',
    ' 1099   359 Mon Nov 23 09:09:35 2026     /Applications/Claude.app/Contents/Helpers/disclaimer',
    ' 1100  1099 Mon Nov 23 09:09:35 2026     /Users/z/Library/Application Support/Claude/claude-code/2.1.330/x/claude.app/Contents/MacOS/claude',
    ' 1200  1100 Mon Nov 23 09:10:00 2026     /bin/sh',
    ' 1201  1200 Mon Nov 23 09:10:00 2026     /opt/homebrew/bin/node',
    ' 2000   500 Mon Nov 23 09:10:00 2026     node',
    '  500     1 Mon Nov  2 9:10:00 2026     -zsh',
  ].join('\n'));
  assert.strictEqual(table.get(1100).comm, '/Users/z/Library/Application Support/Claude/claude-code/2.1.330/x/claude.app/Contents/MacOS/claude');
  assert.strictEqual(table.get(500).start, new Date(2026, 10, 2, 9, 10, 0).getTime());
  const args = new Map([[1201, "/opt/homebrew/bin/node /Users/z/.claude/discord-presence/hook.js SessionStart"], [2000, 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume']]);
  // from the hook's node: skip the hook, skip sh, stop at the bundled claude (not the disclaimer helper or the app)
  assert.strictEqual(P.findClaude(table, args, 1201).pid, 1100);
  assert.strictEqual(P.findClaude(table, args, 2000).pid, 2000, 'npm install (node + @anthropic-ai/claude-code)');
  assert.strictEqual(P.findClaude(table, args, 500), null, 'login shell is not Claude');
  assert.strictEqual(P.isClaude({ comm: '/Applications/Claude.app/Contents/MacOS/Claude' }), false, 'desktop app itself');
  assert.strictEqual(P.isClaude({ comm: '/Users/z/.local/bin/claude' }), true, 'native install');
  assert.strictEqual(P.isClaude({ comm: '/bin/zsh' }, 'zsh -c claude'), false);
  assert.strictEqual(P.isClaude({ comm: 'node' }, 'node /x/.claude/discord-presence/daemon.js'), false, 'our own processes');
  const anc = [{ pid: 1201, comm: '/opt/homebrew/bin/node', args: args.get(1201) }, { pid: 1200, comm: '/bin/sh' }, { pid: 1100, comm: table.get(1100).comm, start: 5 }];
  assert.strictEqual(P.fromAncestors(anc).pid, 1100);
  assert.strictEqual(P.fromAncestors(null), null);
});

test('process table: live ps on this machine finds this process and its start time', { skip: ONLY_POSIX }, () => {
  const P = require('../app/lib/proc');
  const a = P.ancestorsSync(process.pid);
  assert.strictEqual(a[0].pid, process.pid);
  assert.ok(Math.abs(a[0].start - (Date.now() - process.uptime() * 1000)) < 5000, 'start time matches process uptime');
  assert.strictEqual(a[0].args && a[0].args.includes('node'), true);
});

test('daemon address: short Unix socket path, deterministic, private directory, refuses a planted symlink', { skip: ONLY_POSIX }, () => {
  const base = fs.mkdtempSync('/tmp/cdp-base-');
  const long = path.join(tmp, 'x'.repeat(120), WEIRD);
  const evalPipe = (dataDir) => spawnSync(process.execPath, ['-e', "process.stdout.write(require(process.argv[1]).pipeName())", path.join(__dirname, '..', 'app', 'lib', 'common.js')], { env: { ...process.env, CDP_DATA_DIR: dataDir, CDP_SOCKET_BASE: base, CDP_PIPE_NAME: '' }, encoding: 'utf8' }).stdout;
  const short = path.join(tmp, 'd');
  assert.strictEqual(evalPipe(short), path.join(short, 'state', 'daemon.sock'));
  const a = evalPipe(long), b = evalPipe(long);
  assert.strictEqual(a, b, 'same address in hook, daemon, CLI, installer');
  assert.ok(Buffer.byteLength(a) <= 103 && a.startsWith(base), a);
  assert.strictEqual(fs.statSync(path.dirname(a)).mode & 0o777, 0o700);
  assert.notStrictEqual(evalPipe(long + '2'), a, 'another install, another socket');
  // someone else's symlink at the first directory name → not used
  const uid = process.getuid();
  fs.rmSync(path.dirname(a), { recursive: true });
  fs.symlinkSync(tmp, path.join(base, `cdp-${uid}`));
  const c = evalPipe(long);
  assert.ok(!c.startsWith(path.join(base, `cdp-${uid}`) + '/'), c);
  assert.ok(c.startsWith(path.join(base, `cdp-${uid}-`)), c);
  fs.rmSync(base, { recursive: true, force: true });
});

function runLockers(addr, n) {
  const script = `const net=require('net');const {listenExclusive}=require(${JSON.stringify(path.join(__dirname, '..', 'app', 'lib', 'singleton.js'))});
    const srv=net.createServer(s=>{s.on('error',()=>{});s.end('x');});listenExclusive(srv,process.argv[1],{log:m=>process.stderr.write(m+'\\n')}).then(r=>{process.stdout.write(r.ok?'OWNER':'OTHER:'+r.reason);if(r.ok)setTimeout(()=>process.exit(0),2500);else process.exit(0);},e=>{process.stdout.write('ERR '+e.message);process.exit(1);});`;
  return Promise.all(Array.from({ length: n }, () => new Promise(resolve => {
    const p = spawn(process.execPath, ['-e', script, addr], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', () => resolve({ out, err }));
  })));
}

test('single instance: 8 simultaneous starts → exactly one owner', async () => {
  const dir = POSIX ? fs.mkdtempSync('/tmp/cdp-lock-') : null;
  const addr = POSIX ? path.join(dir, 'd.sock') : `\\\\.\\pipe\\cdp-lock-${Math.random().toString(36).slice(2)}`;
  try {
    const res = await runLockers(addr, 8);
    assert.strictEqual(res.filter(r => r.out === 'OWNER').length, 1, JSON.stringify(res));
    assert.strictEqual(res.filter(r => r.out === 'OTHER:running').length, 7, JSON.stringify(res));
  } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('single instance: socket orphaned by a crash is taken over (once), a live one never removed', { skip: ONLY_POSIX }, async () => {
  const dir = fs.mkdtempSync('/tmp/cdp-lock-');
  const addr = path.join(dir, 'd.sock');
  // a process that listens and is then killed with SIGKILL leaves the socket file behind
  const victim = spawn(process.execPath, ['-e', `require('net').createServer().listen(process.argv[1],()=>process.stdout.write('up'))`, addr], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => victim.stdout.once('data', r));
  victim.kill('SIGKILL'); await new Promise(r => victim.on('exit', r));
  assert.ok(fs.lstatSync(addr).isSocket(), 'orphaned socket left behind');
  try {
    const res = await runLockers(addr, 6);
    assert.strictEqual(res.filter(r => r.out === 'OWNER').length, 1, JSON.stringify(res));
    assert.strictEqual(res.filter(r => /removed a stale socket/.test(r.err)).length, 1, 'removed exactly once');
    assert.ok(!fs.existsSync(addr + '.lock'), 'recovery lock released');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude desktop on macOS: window states without and with Accessibility, never guessing', () => {
  const { macState, fromMac, watcherCommand } = require('../app/lib/window-watch');
  assert.strictEqual(macState({ running: false }).state, 'not-running');
  assert.deepStrictEqual(macState({ running: true, onscreen: 1, ax: { status: 'off' } }), { state: 'open', mode: 'unknown', accessibility: 'off' });
  assert.strictEqual(macState({ running: true, onscreen: 0, hidden: true }).state, 'hidden');
  assert.strictEqual(macState({ running: true, onscreen: 0 }).state, 'unknown', 'minimized / other Space / closed are indistinguishable without Accessibility');
  assert.strictEqual(macState({ running: true, onscreen: 0, ax: { status: 'denied', code: '-1743' } }).state, 'unknown');
  assert.strictEqual(macState({ running: true, onscreen: 0, ax: { status: 'ok', windows: [{ minimized: true }] } }).state, 'minimized');
  assert.strictEqual(macState({ running: true, onscreen: 0, ax: { status: 'ok', windows: [] } }).state, 'closed');
  assert.strictEqual(macState({ running: true, onscreen: 0, ax: { status: 'ok', windows: [{ minimized: false }], mode: 'code' } }).state, 'open', 'window on another Space');
  assert.strictEqual(macState({ running: true, onscreen: 1, ax: { status: 'ok', windows: [{ minimized: false }], mode: 'chat' } }).mode, 'chat');
  assert.strictEqual(macState({ running: true, onscreen: 1, ax: { status: 'off', mode: 'chat' } }).mode, 'unknown', 'mode only from Accessibility');
  // only a known-closed window hides desktop sessions
  assert.deepStrictEqual(fromMac({ running: true, onscreen: 0 }, [7]).vis, { 7: true });
  assert.deepStrictEqual(fromMac({ running: true, onscreen: 0, hidden: true }, [7]).vis, { 7: true });
  assert.deepStrictEqual(fromMac({ running: true, onscreen: 0, ax: { status: 'ok', windows: [{ minimized: true }] } }, [7]).vis, { 7: true });
  assert.deepStrictEqual(fromMac({ running: true, onscreen: 0, ax: { status: 'ok', windows: [] } }, [7]).vis, { 7: false });
  assert.strictEqual(watcherCommand({ platform: 'darwin', appDir: '/a', macAccessibility: false }).cmd, '/usr/bin/osascript');
  assert.deepStrictEqual(watcherCommand({ platform: 'darwin', appDir: '/a', macAccessibility: true }).args.slice(-2), ['/a/lib/window-watch-mac.jxa', '1']);
  assert.strictEqual(watcherCommand({ platform: 'win32', appDir: 'C:\\a', daemonPid: 1, pidFile: 'p' }).cmd, 'powershell.exe');
  assert.strictEqual(watcherCommand({ platform: 'linux', appDir: '/a' }), null);
});

test('Claude desktop on macOS: the JXA watcher runs without permissions and prints facts only', { skip: ONLY_DARWIN }, async () => {
  const p = spawn('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, '..', 'app', 'lib', 'window-watch-mac.jxa'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const line = await new Promise((resolve, reject) => {
    let b = ''; const t = setTimeout(() => reject(new Error('no output')), 15000);
    p.stdout.on('data', d => { b += d; const i = b.indexOf('\n'); if (i >= 0) { clearTimeout(t); resolve(b.slice(0, i)); } });
  });
  p.kill();
  const v = JSON.parse(line);
  assert.strictEqual(typeof v.running, 'boolean');
  if (v.running) { assert.strictEqual(typeof v.onscreen, 'number'); assert.deepStrictEqual(v.ax, { status: 'off' }); }
  assert.ok(!/title|name/i.test(Object.keys(v).join()), 'no window titles');
});

test('autostart (macOS): LaunchAgent XML escaping, absolute paths, no KeepAlive; on/off touch only our file', () => {
  const a = require('../app/lib/autostart');
  const node = `/Users/Zoë/.nvm/versions/node/v22.1.0/bin/node`;
  const daemon = `/Users/Zoë/a&b <c> "d" 'e'/.claude/discord-presence/daemon.js`;
  const x = a.plistXml(node, daemon);
  assert.ok(x.includes(`<string>/Users/Zoë/a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;/.claude/discord-presence/daemon.js</string>`));
  assert.ok(x.includes(`<string>${node}</string>`) && x.includes('<string>--standby</string>'));
  assert.ok(/<key>KeepAlive<\/key><false\/>/.test(x) && /<key>RunAtLoad<\/key><true\/>/.test(x));
  assert.ok(x.includes('<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>'), 'environment independent of the login shell');
  if (process.platform === 'darwin') {
    const f = path.join(tmp, 'lint.plist'); fs.writeFileSync(f, x);
    execFileSync('/usr/bin/plutil', ['-lint', f]);
    assert.strictEqual(execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.1', 'raw', f], { encoding: 'utf8' }).trim(), daemon);
  }
  const dir = path.join(tmp, 'LaunchAgents ż');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'com.other.agent.plist'), 'other');
  const logF = path.join(tmp, 'launchctl.log');
  process.env.CDP_LAUNCH_AGENTS_DIR = dir;
  if (POSIX) { const fake = path.join(tmp, 'fake-launchctl'); fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${logF}'\n`, { mode: 0o755 }); process.env.CDP_LAUNCHCTL = fake; }
  else process.env.CDP_LAUNCHCTL = 'none';
  try {
    const M = { platform: 'darwin' };
    const f = a.enable(node, daemon, M);
    assert.strictEqual(f, path.join(dir, `${a.LABEL}.plist`));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), x);
    a.enable('/opt/homebrew/bin/node', daemon, M); // reinstall → paths updated, still one file
    assert.ok(fs.readFileSync(f, 'utf8').includes('<string>/opt/homebrew/bin/node</string>'));
    assert.ok(a.isEnabled(M));
    assert.ok(a.disable(M));
    assert.ok(!a.isEnabled(M) && !a.disable(M));
    assert.deepStrictEqual(fs.readdirSync(dir), ['com.other.agent.plist'], 'foreign LaunchAgent untouched');
    if (POSIX) {
      const calls = fs.readFileSync(logF, 'utf8').trim().split('\n');
      const uid = process.getuid();
      assert.deepStrictEqual(calls, [`bootout gui/${uid}/${a.LABEL}`, `bootstrap gui/${uid} ${f}`, `bootout gui/${uid}/${a.LABEL}`, `bootstrap gui/${uid} ${f}`, `bootout gui/${uid}/${a.LABEL}`]);
    }
  } finally { Object.assign(process.env, SANDBOX); }
});

test('node path: Homebrew Cellar path replaced by the stable link that resolves to the same binary', () => {
  const { stableNodePath } = require('../app/lib/nodepath');
  const real = '/opt/homebrew/Cellar/node/22.1.0/bin/node';
  const rp = links => p => { if (p === real) return real; if (links[p]) return links[p]; throw new Error('ENOENT'); };
  assert.strictEqual(stableNodePath(real, { platform: 'darwin', realpath: rp({ '/opt/homebrew/opt/node/bin/node': real, '/opt/homebrew/bin/node': real }) }), '/opt/homebrew/opt/node/bin/node');
  assert.strictEqual(stableNodePath(real, { platform: 'darwin', realpath: rp({ '/opt/homebrew/bin/node': real }) }), '/opt/homebrew/bin/node');
  assert.strictEqual(stableNodePath(real, { platform: 'darwin', realpath: rp({ '/opt/homebrew/bin/node': '/elsewhere' }) }), real, 'link to another version → keep the real path');
  assert.strictEqual(stableNodePath('/Users/z/.nvm/versions/node/v22.1.0/bin/node', { platform: 'darwin' }), '/Users/z/.nvm/versions/node/v22.1.0/bin/node');
  assert.strictEqual(stableNodePath('C:\\nodejs\\node.exe', { platform: 'win32' }), 'C:\\nodejs\\node.exe');
});

test('updater: system unpack tool per platform, arguments never spliced into a shell string', () => {
  const { unpackCommand } = require('../app/lib/updater');
  const z = `/tmp/it's "x".zip`, o = '/tmp/o $x';
  assert.deepStrictEqual(unpackCommand(z, o, 'darwin'), { cmd: '/usr/bin/ditto', args: ['-x', '-k', z, o] });
  assert.deepStrictEqual(unpackCommand(z, o, 'linux'), { cmd: 'unzip', args: ['-q', '-o', z, '-d', o] });
  const w = unpackCommand(z, o, 'win32');
  assert.match(w.cmd, /System32[\\/]tar\.exe$/i);
  assert.deepStrictEqual(w.args, ['-xf', z, '-C', o]);
});

const zipSupport = process.platform === 'darwin' || process.platform === 'win32' ? false : 'creating a test ZIP needs ditto (macOS) or tar.exe (Windows)';
test('updater: real unpack + installer run; failures reported, temp files removed', { skip: zipSupport }, async () => {
  const { update } = require('../app/lib/updater');
  const src = path.join(tmp, 'upd-src'), top = path.join(src, 'repo-main');
  fs.mkdirSync(top, { recursive: true });
  const marker = path.join(tmp, 'upd-marker.txt');
  const mkZip = (installJs) => {
    fs.writeFileSync(path.join(top, 'install.js'), installJs);
    const zip = path.join(tmp, `upd-${Math.random().toString(36).slice(2)}.zip`);
    if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', top, zip]);
    else execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', src, 'repo-main']); // ZIP with a repo-main/ folder, like GitHub
    return zip;
  };
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cdp-update-')).length;
  const fetchFrom = zip => async (url, dest) => { assert.match(url, /^https:\/\/codeload\.github\.com\/o\/r\/zip\/refs\/heads\/main$/); fs.copyFileSync(zip, dest); };
  const ok = mkZip(`require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.CDP_INSTALL_DIR)`);
  await update({ repo: 'o/r', appDir: '/inst dir', fetch: fetchFrom(ok), log: () => {} });
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), '/inst dir');
  const bad = mkZip('process.exit(3)');
  await assert.rejects(update({ repo: 'o/r', appDir: '/x', fetch: fetchFrom(bad), log: () => {} }), /installer failed \(exit 3\)/);
  await assert.rejects(update({ repo: 'o/r', appDir: '/x', fetch: async (u, d) => fs.writeFileSync(d, '<html>'), log: () => {} }), /not a ZIP/);
  await assert.rejects(update({ repo: 'o/r', appDir: '/x', fetch: async () => { throw new Error('HTTP 404'); }, log: () => {} }), /HTTP 404/);
  await assert.rejects(update({ repo: 'bad repo', appDir: '/x', log: () => {} }), /owner\/name/);
  assert.strictEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cdp-update-')).length, tmpBefore, 'temporary directories removed');
});

// ---------------------------------------------------------------------------
// Release downloads (tools/build-release.js) and the double-click installers
// ---------------------------------------------------------------------------
function unpackZip(zipFile, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-x', '-k', zipFile, dest]);
  else if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipFile, '-C', dest]);
  else execFileSync('unzip', ['-q', zipFile, '-d', dest]);
}
const relDir = path.join(tmp, 'release');
let relBuilt = null;
const relBuild = () => relBuilt || (relBuilt = require('../tools/build-release').build('v9.8.7', path.join(relDir, 'dist')));

test('release: macOS and Windows ZIPs with one top folder, installer, app files; valid CRC', () => {
  const { crc32 } = require('../tools/build-release');
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926, 'standard CRC-32 check value');
  const r = relBuild();
  assert.deepStrictEqual(Object.keys(r).sort(), ['macos', 'windows']);
  assert.match(path.basename(r.macos), /^claude-code-discord-presence-9\.8\.7-macos\.zip$/);
  for (const [k, f] of Object.entries(r)) {
    const dest = path.join(relDir, k);
    unpackZip(f, dest);
    assert.deepStrictEqual(fs.readdirSync(dest), ['claude-code-discord-presence-9.8.7']);
    const top = path.join(dest, 'claude-code-discord-presence-9.8.7');
    for (const p of ['install.js', 'README.md', 'LICENSE', 'config.example.json', 'app/daemon.js', 'app/hook.js', 'app/lib/window-watch-mac.jxa', 'assets/status-working.png']) assert.ok(fs.existsSync(path.join(top, p)), `${k}: ${p}`);
    assert.strictEqual(fs.readFileSync(path.join(top, 'app', 'daemon.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'app', 'daemon.js'), 'utf8'));
    assert.ok(!fs.existsSync(path.join(top, 'test')) && !fs.existsSync(path.join(top, '.github')), 'no tests/CI files in the download');
  }
  const mac = path.join(relDir, 'macos', 'claude-code-discord-presence-9.8.7', 'install-macos.command');
  const win = path.join(relDir, 'windows', 'claude-code-discord-presence-9.8.7', 'install-windows.cmd');
  assert.ok(fs.existsSync(mac) && !fs.existsSync(path.join(relDir, 'macos', 'claude-code-discord-presence-9.8.7', 'install-windows.cmd')));
  assert.ok(fs.existsSync(win) && !fs.existsSync(path.join(relDir, 'windows', 'claude-code-discord-presence-9.8.7', 'install-macos.command')));
  assert.ok(!fs.readFileSync(mac, 'utf8').includes('\r'), 'macOS script with LF');
  assert.ok(/\r\n/.test(fs.readFileSync(win, 'utf8')) && !/[^\r]\n/.test(fs.readFileSync(win, 'utf8')), 'Windows script with CRLF only');
  if (POSIX) assert.strictEqual(fs.statSync(mac).mode & 0o111, 0o111, 'install-macos.command is executable after unzip');
  assert.throws(() => require('../tools/build-release').build('latest'), /version/);
});

function sandboxEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, CDP_INSTALL_DIR: path.join(home, '.claude', 'discord-presence'), CDP_SETTINGS: path.join(home, '.claude', 'settings.json'),
    CDP_LAUNCH_AGENTS_DIR: path.join(home, 'LaunchAgents'), CDP_STARTUP_DIR: path.join(home, 'Startup'), CDP_LAUNCHCTL: 'none', CDP_NO_PAUSE: '1', CDP_DATA_DIR: '' };
}
function checkInstalled(home, appId) {
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(S.countOurs(s), 6);
  assert.strictEqual(s.theme, 'dark', 'existing settings kept');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'discord-presence', 'config.json'), 'utf8')).applicationId, appId);
}

test('installer (macOS .command): invalid ID re-asked, install, autostart, re-run keeps the saved ID', { skip: ONLY_POSIX }, () => {
  relBuild();
  const dir = path.join(relDir, 'macos', 'claude-code-discord-presence-9.8.7');
  if (!fs.existsSync(dir)) unpackZip(relBuilt.macos, path.join(relDir, 'macos'));
  const home = path.join(tmp, `inst home o'k ż`); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"theme":"dark"}');
  const env = { ...sandboxEnv(home), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  let r = spawnSync('/bin/bash', [path.join(dir, 'install-macos.command')], { env, input: 'abc\n123456789012345678\ny\n', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /does not look like an Application ID/);
  checkInstalled(home, '123456789012345678');
  assert.ok(fs.existsSync(path.join(home, 'LaunchAgents', 'io.github.marcelbaka.claude-code-discord-presence.plist')), 'autostart answered y');
  r = spawnSync('/bin/bash', [path.join(dir, 'install-macos.command')], { env, input: '\nn\n', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /keep the saved one \(123456789012345678\)/);
  assert.match(r.stdout, /unchanged/);
  r = spawnSync('/bin/bash', [path.join(dir, 'install-macos.command')], { env: { ...env, PATH: '/usr/bin:/bin', HOME: path.join(tmp, 'no-node-home') }, input: '', encoding: 'utf8' });
  if (!fs.existsSync('/usr/local/bin/node') && !fs.existsSync('/opt/homebrew/bin/node')) { assert.strictEqual(r.status, 1); assert.match(r.stdout, /Node\.js was not found/); }
});

test('installer (Windows .cmd): invalid ID re-asked, install, autostart', { skip: process.platform === 'win32' ? false : 'cmd.exe – runs on the Windows CI jobs' }, () => {
  relBuild();
  const dir = path.join(relDir, 'windows', 'claude-code-discord-presence-9.8.7');
  if (!fs.existsSync(dir)) unpackZip(relBuilt.windows, path.join(relDir, 'windows'));
  const home = path.join(tmp, `inst home o'k ż`); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"theme":"dark"}');
  const input = path.join(tmp, 'win-input.txt');
  fs.writeFileSync(input, 'abc\r\n123456789012345678\r\ny\r\n');
  const fd = fs.openSync(input, 'r'); // a file (not a pipe) behind stdin, like "< input.txt"
  let r;
  try { r = spawnSync('cmd.exe', ['/d', '/c', 'install-windows.cmd'], { cwd: dir, env: sandboxEnv(home), stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' }); } finally { fs.closeSync(fd); }
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /does not look like an Application ID/);
  checkInstalled(home, '123456789012345678');
  assert.ok(fs.existsSync(path.join(home, 'Startup', 'Claude Code Discord Presence.vbs')), 'autostart answered y');
});

test('macOS watcher: a plain "Claude" window title is never reported as the chat tab', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'window-watch-mac.jxa'), 'utf8');
  const fnSrc = /function modeFromTitle\(t\) \{[\s\S]*?\n\}/.exec(src)[0];
  const modeFromTitle = new Function(`${fnSrc}; return modeFromTitle;`)();
  assert.strictEqual(modeFromTitle('Claude'), 'unknown', 'title is "Claude" in both tabs on macOS');
  assert.strictEqual(modeFromTitle('Some chat - Claude'), 'unknown');
  assert.strictEqual(modeFromTitle('My project - Claude Code'), 'code');
  assert.strictEqual(modeFromTitle(''), 'unknown');
});
