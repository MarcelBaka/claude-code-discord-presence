'use strict';
// Test end-to-end: prawdziwy hook.js + daemon.js, atrapa klienta Discord (ten sam
// protokół IPC na osobnym potoku) i atrapy procesów Claude (prawdziwe PID-y).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { encode, OP } = require('../app/lib/discord-ipc');

const APP = path.join(__dirname, '..', 'app');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-int-'));
const rnd = Math.random().toString(36).slice(2, 8);
const env = {
  ...process.env,
  CDP_DATA_DIR: path.join(tmp, 'data'),
  CDP_CLAUDE_DIR: path.join(tmp, 'claude'),
  CDP_PIPE_NAME: `\\\\.\\pipe\\cdp-test-daemon-${rnd}`,
  CDP_DISCORD_PIPE_PREFIX: `\\\\.\\pipe\\cdp-test-discord-${rnd}-`,
  CDP_FAST: '1',
  CDP_PROJECTS_DIR: path.join(tmp, 'projects'),
  CDP_STARTUP_DIR: path.join(tmp, 'startup'),
};
fs.mkdirSync(env.CDP_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(env.CDP_CLAUDE_DIR, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(env.CDP_DATA_DIR, 'config.json'), JSON.stringify({ language: 'pl', largeImageKey: 'none', showStatus: false, showModel: false, showToday: 'off', showChat: false, assetBaseUrl: '', applicationId: '123456789012345678', aliases: { 'beta-repo': 'Beta – alias' } }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, what = 'warunek') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timeout: ${what}`);
}

// ---------- atrapa Discorda ----------
class FakeDiscord {
  constructor() { this.activities = []; this.sockets = new Set(); this.server = null; this.handshakes = 0; }
  start() {
    return new Promise(resolve => {
      this.server = net.createServer(sock => {
        this.sockets.add(sock);
        let buf = Buffer.alloc(0);
        sock.on('data', d => {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 8) {
            const op = buf.readUInt32LE(0), len = buf.readUInt32LE(4);
            if (buf.length < 8 + len) break;
            const msg = JSON.parse(buf.toString('utf8', 8, 8 + len)); buf = buf.subarray(8 + len);
            if (op === OP.HANDSHAKE) { this.handshakes++; this.clientId = msg.client_id; sock.write(encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { id: '1' } } })); }
            else if (op === OP.FRAME && msg.cmd === 'SET_ACTIVITY') {
              this.activities.push({ at: Date.now(), activity: msg.args.activity || null, pid: msg.args.pid });
              sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', nonce: msg.nonce, data: msg.args.activity || null, evt: null }));
            }
          }
        });
        sock.on('error', () => {}); sock.on('close', () => this.sockets.delete(sock));
      });
      this.server.listen(`${env.CDP_DISCORD_PIPE_PREFIX}0`, resolve);
    });
  }
  stop() { for (const s of this.sockets) s.destroy(); return new Promise(r => this.server.close(() => r())); }
  last() { return this.activities[this.activities.length - 1]; }
}

// ---------- atrapy procesów Claude ----------
const procs = [];
function fakeClaude(sessionId, startedAt) {
  const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore', windowsHide: true });
  procs.push(p);
  fs.writeFileSync(path.join(env.CDP_CLAUDE_DIR, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId, startedAt, kind: 'interactive' }));
  return p;
}

function hook(input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(APP, 'hook.js'), input.hook_event_name], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(input));
  });
}

const asst = (id, ts, u) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id, usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } } }) + '\n';

function daemonAlive() {
  return new Promise(resolve => {
    const s = net.createConnection(env.CDP_PIPE_NAME);
    s.on('connect', () => s.end('ping\n')); s.on('data', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}
const logText = () => { try { return fs.readFileSync(path.join(env.CDP_DATA_DIR, 'logs', 'presence.log'), 'utf8'); } catch { return ''; } };
const status = () => JSON.parse(fs.readFileSync(path.join(env.CDP_DATA_DIR, 'state', 'status.json'), 'utf8'));

test('pełny scenariusz: start, duplikaty, tokeny, wiele projektów, awaria, Discord, zamknięcie', { timeout: 120000 }, async t => {
  const discord = new FakeDiscord();
  // projekty
  const repoA = path.join(tmp, 'Projekt Ąę ż spacją'); fs.mkdirSync(path.join(repoA, '.git'), { recursive: true }); fs.mkdirSync(path.join(repoA, 'src'));
  const repoB = path.join(tmp, 'beta-repo'); fs.mkdirSync(path.join(repoB, '.git'), { recursive: true });
  const proj = path.join(tmp, 'projects'); fs.mkdirSync(proj);
  const trA = path.join(proj, 'sess-a.jsonl'), trB = path.join(proj, 'sess-b.jsonl');

  const startA = Date.now() - 60000; // proces Claude A „uruchomiony” minutę temu (wznowiona rozmowa)
  fs.writeFileSync(trA, asst('old1', startA - 3600e3, [10, 1000, 50000, 5000]) + asst('a1', startA + 1000, [3, 100, 2000, 400]));
  const pA = fakeClaude('sess-a', startA);

  await t.test('brak Discorda: hooki nie blokują, jeden proces mimo równoczesnego startu', async () => {
    const t0 = Date.now();
    const res = await Promise.all(Array.from({ length: 6 }, () => hook({ hook_event_name: 'SessionStart', session_id: 'sess-a', transcript_path: trA, cwd: path.join(repoA, 'src'), source: 'resume' })));
    for (const r of res) { assert.strictEqual(r.code, 0); assert.strictEqual(r.out, ''); assert.strictEqual(r.err, ''); }
    assert.ok(Date.now() - t0 < 8000, 'hooki muszą kończyć się szybko');
    await waitFor(daemonAlive, 8000, 'demon');
    await sleep(1500);
    assert.strictEqual((logText().match(/daemon started/g) || []).length, 1, 'dokładnie jeden demon');
    const st = await waitFor(() => { try { const s = status(); return s.discord.state === 'waiting' && s; } catch { return false; } }, 8000, 'status waiting');
    assert.match(st.discord.error, /Discord is not running/);
    // payload liczony mimo braku Discorda: tylko a1 (old1 sprzed uruchomienia pominięte)
    assert.strictEqual(st.activityPayload.state, 'Tokeny sesji: 503'); // 3 + 100 + 400 (bez cache read)
    assert.strictEqual(st.activityPayload.details, 'Projekt: Projekt Ąę ż spacją');
    assert.strictEqual(st.activityPayload.timestamps.start, startA);
  });

  await t.test('Discord uruchomiony po Claude → połączenie z backoffem i aktywność', async () => {
    await discord.start();
    const a = await waitFor(() => discord.last(), 15000, 'aktywność');
    assert.strictEqual(discord.clientId, '123456789012345678');
    assert.deepStrictEqual(a.activity, { details: 'Projekt: Projekt Ąę ż spacją', state: 'Tokeny sesji: 503', timestamps: { start: startA }, type: 3 }); // domyślnie „Ogląda”
    const json = JSON.stringify(a.activity);
    assert.ok(!json.includes(tmp) && !json.includes('\\') && !json.includes(os.userInfo().username), 'bez ścieżek i nazwy użytkownika');
  });

  await t.test('przyrost tokenów: duplikaty bloków i częściowa linia', async () => {
    fs.appendFileSync(trA, asst('a2', Date.now(), [1, 1000, 9000, 1000]) + asst('a2', Date.now(), [1, 1000, 9000, 1000]) + asst('a2', Date.now(), [1, 1000, 9000, 1000]));
    fs.appendFileSync(trA, '{"type":"system","subtype":"compact_boundary"}\n{"type":"assistant","timestamp":"' + new Date().toISOString() + '","message":{"id":"a3","usage":{"input_tok');
    const a = await waitFor(() => { const l = discord.last(); return l && l.activity && l.activity.state === 'Tokeny sesji: 2,5 tys.' && l; }, 10000, '2,5 tys.');
    assert.strictEqual(a.activity.timestamps.start, startA, 'licznik czasu nie resetuje się');
    fs.appendFileSync(trA, 'ens":0,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
    await waitFor(() => { const l = discord.last(); return l && l.activity && l.activity.state === 'Tokeny sesji: 3 tys.'; }, 10000, '3 tys.');
  });

  const startB = Date.now();
  const pB = fakeClaude('sess-b', startB);
  await t.test('druga sesja w innym projekcie; przełączanie wg aktywności użytkownika', async () => {
    await hook({ hook_event_name: 'SessionStart', session_id: 'sess-b', transcript_path: trB, cwd: repoB, source: 'startup' });
    let a = await waitFor(() => { const l = discord.last(); return l.activity && l.activity.details === 'Projekt: Beta – alias' && l; }, 10000, 'projekt B');
    assert.strictEqual(a.activity.state, 'Tokeny: brak danych', 'brak transkryptu ≠ zero');
    assert.strictEqual(a.activity.timestamps.start, startB);
    fs.writeFileSync(trB, asst('b1', Date.now(), [0, 50, 0, 0]));
    await waitFor(() => discord.last().activity.state === 'Tokeny sesji: 50', 10000, 'B 50');
    // prompt w A → A aktywna
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-a', transcript_path: trA, cwd: repoA, prompt: 'TAJNY PROMPT' });
    a = await waitFor(() => { const l = discord.last(); return l.activity.details.includes('Ąę') && l; }, 10000, 'powrót do A');
    assert.strictEqual(a.activity.timestamps.start, startA);
    // zmiana katalogu w B (to nie aktywność użytkownika) nie przełącza projektu
    await hook({ hook_event_name: 'CwdChanged', session_id: 'sess-b', transcript_path: trB, cwd: repoB, old_cwd: repoB, new_cwd: repoB });
    await sleep(1500);
    assert.ok(discord.last().activity.details.includes('Ąę'));
    assert.ok(!fs.readFileSync(path.join(env.CDP_DATA_DIR, 'state', 'registry.json'), 'utf8').includes('TAJNY'), 'prompt nie jest zapisywany');
    assert.ok(!logText().includes('TAJNY'));
  });

  await t.test('awaryjne zamknięcie terminala aktywnej sesji → przełączenie na inną', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-b', transcript_path: trB, cwd: repoB, prompt: 'x' });
    await waitFor(() => discord.last().activity.details === 'Projekt: Beta – alias', 10000, 'B aktywna');
    pB.kill('SIGKILL');
    await waitFor(() => discord.last().activity.details.includes('Ąę'), 10000, 'po awarii B → A');
    assert.match(logText(), /process gone/);
  });

  await t.test('restart Discorda → ponowne połączenie bez resetu licznika czasu', async () => {
    const before = discord.handshakes;
    await discord.stop();
    discord.activities = [];
    await sleep(800);
    await discord.start();
    const a = await waitFor(() => discord.last(), 15000, 'aktywność po restarcie');
    assert.ok(discord.handshakes > before);
    assert.strictEqual(a.activity.timestamps.start, startA);
  });

  await t.test('Stop (koniec odpowiedzi) i długa bezczynność nie zamykają sesji', async () => {
    await sleep(3500); // > grace w trybie testowym
    assert.ok(await daemonAlive());
    assert.ok(discord.last().activity);
  });

  await t.test('SessionEnd ostatniej sesji → wyczyszczenie aktywności i zakończenie procesu', async () => {
    await hook({ hook_event_name: 'SessionEnd', session_id: 'sess-a', transcript_path: trA, cwd: repoA, reason: 'prompt_input_exit' });
    await waitFor(() => discord.last().activity === null, 10000, 'czyszczenie aktywności');
    await waitFor(async () => !(await daemonAlive()), 10000, 'koniec demona');
    assert.match(logText(), /shutdown: no open sessions/);
  });

  await t.test('wyłączenie integracji: hook nic nie uruchamia', async () => {
    const cfgFile = path.join(env.CDP_DATA_DIR, 'config.json');
    const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); c.enabled = false; fs.writeFileSync(cfgFile, JSON.stringify(c));
    await hook({ hook_event_name: 'SessionStart', session_id: 'sess-a', transcript_path: trA, cwd: repoA, source: 'startup' });
    await sleep(1500);
    assert.strictEqual(await daemonAlive(), false);
  });

  pA.kill(); await discord.stop();
});

test.after(() => { for (const p of procs) { try { p.kill(); } catch {} } });

test('/clear w tym samym procesie: licznik czasu i tokeny od uruchomienia zachowane', { timeout: 60000 }, async () => {
  const cfgFile = path.join(env.CDP_DATA_DIR, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); c.enabled = true; fs.writeFileSync(cfgFile, JSON.stringify(c));
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'clear-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const t1 = path.join(tmp, 'projects', 'c1.jsonl'), t2 = path.join(tmp, 'projects', 'c2.jsonl');
  const start = Date.now() - 5000;
  fs.writeFileSync(t1, asst('c1m', Date.now(), [0, 700, 0, 0]));
  const p = fakeClaude('c1', start);
  await hook({ hook_event_name: 'SessionStart', session_id: 'c1', transcript_path: t1, cwd: repo, source: 'startup' });
  await waitFor(() => discord.last() && discord.last().activity && discord.last().activity.state === 'Tokeny sesji: 700', 15000, 'c1');
  await hook({ hook_event_name: 'SessionEnd', session_id: 'c1', transcript_path: t1, cwd: repo, reason: 'clear' });
  fs.writeFileSync(path.join(env.CDP_CLAUDE_DIR, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'c2', startedAt: start }));
  fs.writeFileSync(t2, asst('c2m', Date.now(), [0, 300, 0, 0]));
  await hook({ hook_event_name: 'SessionStart', session_id: 'c2', transcript_path: t2, cwd: repo, source: 'clear' });
  const a = await waitFor(() => { const l = discord.last(); return l.activity && l.activity.state === 'Tokeny sesji: 1 tys.' && l; }, 15000, 'c1+c2');
  assert.strictEqual(a.activity.timestamps.start, start);
  p.kill('SIGKILL');
  await waitFor(() => discord.last().activity === null, 15000, 'czyszczenie po zamknięciu procesu');
  await waitFor(async () => !(await daemonAlive()), 15000, 'koniec demona');
  await discord.stop();
});

test('zamknięcie okna aplikacji Claude desktop → aktywność ukryta, ponowne otwarcie → wraca z tym samym czasem', { timeout: 60000 }, async () => {
  const winFile = path.join(tmp, 'window-state.json');
  fs.writeFileSync(winFile, '{}');
  env.CDP_WINDOW_STATE_FILE = winFile; // zastępuje obserwatora PowerShell w teście
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'okno-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'w1.jsonl'); fs.writeFileSync(tr, asst('w1m', Date.now(), [0, 42, 0, 0]));
  const start = Date.now() - 1000;
  const p = fakeClaude('w1', start);
  fs.writeFileSync(path.join(env.CDP_CLAUDE_DIR, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'w1', startedAt: start, entrypoint: 'claude-desktop' }));
  await hook({ hook_event_name: 'SessionStart', session_id: 'w1', transcript_path: tr, cwd: repo, source: 'startup' });
  await waitFor(() => discord.last() && discord.last().activity && discord.last().activity.details === 'Projekt: okno-repo', 15000, 'widoczna');
  fs.writeFileSync(winFile, JSON.stringify({ [p.pid]: false }));
  await waitFor(() => discord.last().activity === null, 15000, 'ukryta po zamknięciu okna');
  await sleep(3500); // dłużej niż grace – proces nie może się zakończyć, sesja dalej żyje
  assert.ok(await daemonAlive());
  fs.writeFileSync(winFile, JSON.stringify({ [p.pid]: true }));
  const a = await waitFor(() => { const l = discord.last(); return l.activity && l; }, 15000, 'wraca po otwarciu okna');
  assert.strictEqual(a.activity.timestamps.start, start);
  p.kill('SIGKILL');
  await waitFor(async () => !(await daemonAlive()), 15000, 'koniec demona');
  await discord.stop();
  delete env.CDP_WINDOW_STATE_FILE;
});

test('przełączenie na zwykły czat Claude → aktywność czatu; powrót do Code → projekt z tym samym czasem; czat utrzymuje proces', { timeout: 60000 }, async () => {
  const cfgFile = path.join(env.CDP_DATA_DIR, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), showChat: true }));
  const winFile = path.join(tmp, 'window-state-chat.json');
  const setWin = (mode, visible = true, vis = {}) => fs.writeFileSync(winFile, JSON.stringify({ vis, app: { visible, mode } }));
  setWin('code');
  env.CDP_WINDOW_STATE_FILE = winFile;
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'czat-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'ch1.jsonl'); fs.writeFileSync(tr, asst('ch1m', Date.now(), [0, 77, 0, 0]));
  const start = Date.now() - 2000;
  const p = fakeClaude('ch1', start);
  fs.writeFileSync(path.join(env.CDP_CLAUDE_DIR, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'ch1', startedAt: start, entrypoint: 'claude-desktop' }));
  await hook({ hook_event_name: 'SessionStart', session_id: 'ch1', transcript_path: tr, cwd: repo, source: 'startup' });
  await waitFor(() => discord.last() && discord.last().activity && discord.last().activity.details === 'Projekt: czat-repo', 15000, 'tryb Code');

  const tChat = Date.now();
  setWin('chat', true, { [p.pid]: true });
  const c = await waitFor(() => { const l = discord.last(); return l.activity && l.activity.details === 'Rozmawia z Claude' && l; }, 15000, 'tryb czatu');
  assert.strictEqual(c.activity.state, undefined, 'czat nie ma lokalnych danych o tokenach');
  assert.ok(c.activity.timestamps.start >= tChat - 1000, 'licznik czatu od momentu przełączenia');
  assert.strictEqual(c.activity.type, 3);

  setWin('code', true, { [p.pid]: true });
  const back = await waitFor(() => { const l = discord.last(); return l.activity && l.activity.details === 'Projekt: czat-repo' && l; }, 15000, 'powrót do Code');
  assert.strictEqual(back.activity.timestamps.start, start, 'licznik sesji Code bez resetu');

  // wszystkie sesje Code zamknięte, ale aplikacja otwarta na czacie → proces działa dalej
  setWin('chat');
  p.kill('SIGKILL');
  await waitFor(() => { const l = discord.last(); return l.activity && l.activity.details === 'Rozmawia z Claude'; }, 15000, 'czat po zamknięciu sesji');
  await sleep(3500);
  assert.ok(await daemonAlive(), 'czat utrzymuje proces');
  // okno zamknięte → aktywność znika, proces się kończy
  setWin('chat', false);
  await waitFor(() => discord.last().activity === null, 15000, 'wyczyszczenie po zamknięciu okna');
  await waitFor(async () => !(await daemonAlive()), 15000, 'koniec demona');
  await discord.stop();
  delete env.CDP_WINDOW_STATE_FILE;
});

test('stan Claude (Working/Waiting, Esc), model i effort, ikonki stanu, przycisk GitHub, rotacja Today, tryb autostartu', { timeout: 90000 }, async () => {
  const cfgFile = path.join(env.CDP_DATA_DIR, 'config.json');
  const base = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...base, enabled: true, language: 'en', showStatus: true, showModel: true, showToday: 'rotate', showChat: false,
    largeImageKey: 'https://example.test/big.png', assetBaseUrl: 'https://example.test/assets', links: { 'feat-repo': 'https://github.com/example/feat-repo' }, autostart: true }));
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'feat-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const projDir = path.join(tmp, 'projects', 'feat'); fs.mkdirSync(projDir, { recursive: true });
  const tr = path.join(projDir, 'f1.jsonl');
  const line = (id, out, effort = 'high', model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), effort, message: { id, model, usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';
  fs.writeFileSync(tr, line('f1a', 1000));
  // another project's session today (not open any more) - counted in "Today" only
  const other = path.join(tmp, 'projects', 'other'); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'o1.jsonl'), line('o1a', 4000, 'low', 'claude-haiku-5-5'));
  const start = Date.now() - 3000;
  const p = fakeClaude('f1', start);
  const last = () => discord.last() && discord.last().activity;

  await hook({ hook_event_name: 'SessionStart', session_id: 'f1', transcript_path: tr, cwd: repo, source: 'startup' });
  const w = await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Waiting · ') && a; }, 15000, 'Waiting');
  assert.strictEqual(w.details, 'Project: feat-repo');
  assert.match(w.state, /^Waiting · 1k tokens · ~\$0\.02$/);
  assert.strictEqual(w.assets.large_image, 'https://example.test/big.png');
  assert.strictEqual(w.assets.large_text, 'Opus 5.5 · high effort');
  assert.strictEqual(w.assets.small_image, 'https://example.test/assets/status-waiting.png');
  assert.strictEqual(w.assets.small_text, 'Waiting for you');
  assert.deepStrictEqual(w.buttons, [{ label: 'View on GitHub', url: 'https://github.com/example/feat-repo' }]);
  assert.strictEqual(w.timestamps.start, start);

  await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'f1', transcript_path: tr, cwd: repo, prompt: 'x' });
  const k = await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Working · ') && a; }, 15000, 'Working');
  assert.strictEqual(k.assets.small_image, 'https://example.test/assets/status-working.png');
  assert.strictEqual(k.assets.small_text, 'Claude is working…');

  fs.appendFileSync(tr, line('f1b', 500, 'max'));
  await hook({ hook_event_name: 'Stop', session_id: 'f1', transcript_path: tr, cwd: repo });
  const s2 = await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Waiting · 1.5k') && a; }, 15000, 'Waiting after Stop');
  assert.strictEqual(s2.assets.large_text, 'Opus 5.5 · max effort', 'effort follows the latest reply');

  // Esc during a reply: no Stop hook, an interrupt marker in the transcript instead
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'f1', transcript_path: tr, cwd: repo, prompt: 'y' });
  await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Working · '); }, 15000, 'Working 2');
  await sleep(50);
  fs.appendFileSync(tr, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
  await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Waiting · '); }, 15000, 'Waiting after Esc');

  // "Today" slot: both transcripts, any project (1000 + 500 + 4000 output tokens)
  const t = await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Today: ') && a; }, 15000, 'Today rotation');
  assert.match(t.state, /^Today: 5\.5k tokens · ~\$0\.03$/);

  // autostart (standby): no open session -> activity cleared, but the process keeps running
  p.kill('SIGKILL');
  await waitFor(() => discord.last().activity === null, 15000, 'cleared');
  await sleep(3500);
  assert.ok(await daemonAlive(), 'standby keeps the process');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...base, enabled: false }));
  await waitFor(async () => !(await daemonAlive()), 15000, 'stopped');
  await discord.stop();
});
