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
const IS_WIN = process.platform === 'win32';
// Windows: named pipes. macOS/Linux: real Unix sockets in a short directory (sun_path ≤ 104 bytes;
// os.tmpdir() on macOS is long – /var/folders/…/T/).
const sockDir = IS_WIN ? null : fs.mkdtempSync('/tmp/cdp-it-');
const env = {
  ...process.env,
  CDP_DATA_DIR: path.join(tmp, 'data'),
  CDP_CLAUDE_DIR: path.join(tmp, 'claude'),
  CDP_PIPE_NAME: IS_WIN ? `\\\\.\\pipe\\cdp-test-daemon-${rnd}` : path.join(sockDir, 'daemon.sock'),
  CDP_DISCORD_PIPE_PREFIX: IS_WIN ? `\\\\.\\pipe\\cdp-test-discord-${rnd}-` : path.join(sockDir, 'discord-ipc-'),
  CDP_FAST: '1',
  CDP_NO_UPDATE_CHECK: '1',
  CDP_PROJECTS_DIR: path.join(tmp, 'projects'),
  CDP_STARTUP_DIR: path.join(tmp, 'startup'),
  CDP_LAUNCH_AGENTS_DIR: path.join(tmp, 'agents'), // never the real ~/Library/LaunchAgents
  CDP_LAUNCHCTL: 'none',
};
fs.mkdirSync(env.CDP_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(env.CDP_CLAUDE_DIR, 'sessions'), { recursive: true });
fs.mkdirSync(env.CDP_PROJECTS_DIR, { recursive: true });
fs.writeFileSync(path.join(env.CDP_DATA_DIR, 'config.json'), JSON.stringify({ checkUpdates: false, language: 'pl', largeImageKey: 'none', showStatus: false, showModel: false, showToday: 'off', showChat: false, assetBaseUrl: '', applicationId: '123456789012345678', aliases: { 'beta-repo': 'Beta – alias' } }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, what = 'warunek') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timeout: ${what}`);
}

// ---------- atrapa Discorda ----------
const fakeDiscords = new Set(); // closed in test.after even when a test fails half-way
class FakeDiscord {
  constructor() { this.activities = []; this.sockets = new Set(); this.server = null; this.handshakes = 0; fakeDiscords.add(this); }
  async start(addr = `${env.CDP_DISCORD_PIPE_PREFIX}0`) {
    this.addr = addr;
    // a test that failed half-way may have left its fake Discord listening – do not cascade
    for (const d of fakeDiscords) if (d !== this && d.addr === addr && d.server && d.server.listening) await d.stop();
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
      this.server.listen(addr, resolve);
    });
  }
  stop() { // bounded: a client connecting during close must not keep the test waiting
    for (const s of this.sockets) s.destroy();
    return new Promise(r => { const t = setTimeout(() => { for (const s of this.sockets) s.destroy(); r(); }, 2000); this.server.close(() => { clearTimeout(t); r(); }); });
  } // Node removes the Unix socket file on close
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

// bounded: a connection that never answers (or closes without a reply) counts as "not alive"
function daemonAlive() {
  return new Promise(resolve => {
    const s = net.createConnection(env.CDP_PIPE_NAME);
    const done = v => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), 1500);
    s.on('connect', () => s.end('ping\n')); s.on('data', () => done(true));
    s.on('error', () => done(false)); s.on('close', () => done(false));
  });
}
const logText = () => { try { return fs.readFileSync(path.join(env.CDP_DATA_DIR, 'logs', 'presence.log'), 'utf8'); } catch { return ''; } };
const status = () => JSON.parse(fs.readFileSync(path.join(env.CDP_DATA_DIR, 'state', 'status.json'), 'utf8'));

test('pełny scenariusz: start, duplikaty, tokeny, wiele projektów, awaria, Discord, zamknięcie', { timeout: 120000 }, async t => {
  const discord = new FakeDiscord();
  // projekty
  const repoA = path.join(tmp, 'Projekt Ąę ż spacją'); fs.mkdirSync(path.join(repoA, '.git'), { recursive: true }); fs.mkdirSync(path.join(repoA, 'src'));
  const repoB = path.join(tmp, 'beta-repo'); fs.mkdirSync(path.join(repoB, '.git'), { recursive: true });
  const proj = path.join(tmp, 'projects');
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

// cleanup also after a failed test: fake processes, any daemon still listening, sockets, temp dirs
test.after(async () => {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  for (const d of fakeDiscords) { try { for (const s of d.sockets) s.destroy(); d.server && d.server.listening && d.server.close(); } catch {} }
  for (const addr of [env.CDP_PIPE_NAME, ...extraDaemons]) {
    await new Promise(r => { const s = net.createConnection(addr); s.on('connect', () => s.end('stop\n')); s.on('close', r); s.on('error', r); setTimeout(r, 1500); });
  }
  await sleep(500);
  if (sockDir) try { fs.rmSync(sockDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
const extraDaemons = [];

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
  const k = await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Thinking · ') && a; }, 15000, 'Thinking after a prompt');
  assert.strictEqual(k.assets.small_image, 'https://example.test/assets/status-working.png');
  assert.strictEqual(k.assets.small_text, 'Claude: thinking…');

  fs.appendFileSync(tr, line('f1b', 500, 'max'));
  await hook({ hook_event_name: 'Stop', session_id: 'f1', transcript_path: tr, cwd: repo });
  const s2 = await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Waiting · 1.5k') && a; }, 15000, 'Waiting after Stop');
  assert.strictEqual(s2.assets.large_text, 'Opus 5.5 · max effort', 'effort follows the latest reply');

  // Esc during a reply: no Stop hook, an interrupt marker in the transcript instead
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'f1', transcript_path: tr, cwd: repo, prompt: 'y' });
  await waitFor(() => { const a = last(); return a && a.state && a.state.startsWith('Thinking · '); }, 15000, 'Working 2');
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

// ---------------------------------------------------------------------------
// macOS / Unix specific end-to-end cases (explicitly skipped on Windows, where the
// equivalent paths use named pipes, PowerShell process queries and tasklist).
// ---------------------------------------------------------------------------
const S = require('../app/lib/settings');
const ONLY_POSIX = IS_WIN ? 'Unix process tree / sockets (Windows has its own PowerShell + named pipe paths)' : false;
const setCfg = patch => { const f = path.join(env.CDP_DATA_DIR, 'config.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch })); };
// a previous failed test must not leave its daemon (with another environment) running
async function freshStart() {
  // earlier tests may leave the integration disabled (e.g. the autostart test ends with enabled:false)
  setCfg({ enabled: true, checkUpdates: false, autostart: false, showChat: false, showStatus: false, showModel: false, showToday: 'off', language: 'pl' });
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  if (await daemonAlive()) {
    // read the reply (an unread, paused socket never emits 'close') and never wait forever
    await new Promise(r => {
      const s = net.createConnection(env.CDP_PIPE_NAME);
      const t = setTimeout(() => { s.destroy(); r(); }, 3000);
      const done = () => { clearTimeout(t); r(); };
      s.on('connect', () => s.end('stop\n')); s.on('data', () => {}); s.on('close', done); s.on('error', done);
    });
    await waitFor(async () => !(await daemonAlive()), 10000, 'previous daemon stopped');
  }
}
const sessionsInStatus = () => { try { return status().sessions || []; } catch { return []; } };

test('PID without ~/.claude/sessions: real process tree claude → sh -c → hook, shell already gone', { timeout: 60000, skip: ONLY_POSIX }, async () => {
  await freshStart();
  setCfg({ enabled: true, checkUpdates: false, autostart: false, showChat: false, showStatus: false, showToday: 'off', language: 'pl' });
  const discord = new FakeDiscord(); await discord.start();
  // a fake Claude Code: a Node script literally named "claude" that runs hooks the way Claude does (sh -c "<command>")
  const binDir = path.join(tmp, 'bin'); fs.mkdirSync(binDir, { recursive: true });
  const claudeJs = path.join(binDir, 'claude');
  fs.writeFileSync(claudeJs, `const {spawn}=require('child_process');require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);const p=spawn('/bin/sh',['-c',m.cmd],{env:m.env,stdio:['pipe','ignore','ignore']});p.stdin.end(JSON.stringify(m.input));p.on('close',c=>process.stdout.write(JSON.stringify({id:m.id,code:c})+'\\n'));});setInterval(()=>{},1e9);`);
  const fc = spawn(process.execPath, [claudeJs], { stdio: ['pipe', 'pipe', 'ignore'] });
  procs.push(fc);
  let n = 0;
  const runHook = input => new Promise(resolve => {
    const id = ++n;
    const onData = d => { for (const l of String(d).trim().split('\n')) { try { const m = JSON.parse(l); if (m.id === id) { fc.stdout.off('data', onData); resolve(m.code); } } catch {} } };
    fc.stdout.on('data', onData);
    fc.stdin.write(JSON.stringify({ id, cmd: S.commandFor(process.execPath, path.join(APP, 'hook.js'), input.hook_event_name), env, input }) + '\n');
  });
  const repo = path.join(tmp, 'tree-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'tree1.jsonl'); fs.writeFileSync(tr, asst('t1m', Date.now(), [0, 321, 0, 0]));
  assert.strictEqual(await runHook({ hook_event_name: 'SessionStart', session_id: 'tree1', transcript_path: tr, cwd: repo, source: 'startup' }), 0);
  const s = await waitFor(() => sessionsInStatus().find(x => x.id === 'tree1' && x.pid), 15000, 'pid via process tree');
  assert.strictEqual(s.pid, fc.pid, 'the Claude process, not the hook shell');
  assert.strictEqual(s.pidVia, 'process-tree');
  const a = await waitFor(() => { const l = discord.last(); return l && l.activity && l.activity.details === 'Projekt: tree-repo' && l; }, 15000, 'activity');
  assert.strictEqual(a.activity.state, 'Tokeny sesji: 321');
  // the shell that ran the hook is gone; Claude closing (terminal closed) still ends the session
  fc.kill('SIGKILL');
  await waitFor(() => discord.last().activity === null, 15000, 'cleared after Claude exit');
  await waitFor(async () => !(await daemonAlive()), 15000, 'daemon exits');
  await discord.stop();
});

test('reused PID: a live process whose start time differs from Claude\'s record does not keep the session', { timeout: 60000, skip: ONLY_POSIX }, async () => {
  await freshStart();
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'reuse-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'reuse.jsonl'); fs.writeFileSync(tr, asst('r1m', Date.now(), [0, 10, 0, 0]));
  const trOk = path.join(tmp, 'projects', 'reuse-ok.jsonl'); fs.writeFileSync(trOk, asst('r2m', Date.now(), [0, 20, 0, 0]));
  const proc = require('../app/lib/proc');
  // genuine: procStart equals the real start time (Claude writes it in UTC)
  const good = fakeClaude('reuse-ok', Date.now());
  await sleep(300);
  const real = proc.ancestorsSync(good.pid)[0].start;
  const fmt = t => { const d = new Date(t); const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; const p = v => String(v).padStart(2, '0'); return `${D[d.getUTCDay()]} ${M[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`; };
  fs.writeFileSync(path.join(env.CDP_CLAUDE_DIR, 'sessions', `${good.pid}.json`), JSON.stringify({ pid: good.pid, sessionId: 'reuse-ok', startedAt: real + 1000, procStart: fmt(real) }));
  // reused: the PID is alive, but Claude recorded a process that started two days earlier
  const other = fakeClaude('reuse', Date.now());
  fs.writeFileSync(path.join(env.CDP_CLAUDE_DIR, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: 'reuse', startedAt: real - 172800e3, procStart: fmt(real - 172800e3) }));
  await hook({ hook_event_name: 'SessionStart', session_id: 'reuse-ok', transcript_path: trOk, cwd: repo, source: 'startup' });
  await hook({ hook_event_name: 'SessionStart', session_id: 'reuse', transcript_path: tr, cwd: repo, source: 'startup' });
  await waitFor(() => /pid reused/.test(logText()) && !sessionsInStatus().some(x => x.id === 'reuse'), 15000, 'reused PID dropped');
  assert.ok(sessionsInStatus().some(x => x.id === 'reuse-ok'), 'genuine session kept');
  await waitFor(() => { try { return status().active.sessionId === 'reuse-ok'; } catch { return false; } }, 15000, 'card shows the genuine session');
  good.kill('SIGKILL'); other.kill('SIGKILL');
  await waitFor(async () => !(await daemonAlive()), 15000, 'daemon exits');
  await discord.stop();
});

test('daemon killed with SIGKILL: orphaned socket recovered, simultaneous hooks still start exactly one daemon', { timeout: 60000, skip: ONLY_POSIX }, async () => {
  await freshStart();
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'crash-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'crash.jsonl'); fs.writeFileSync(tr, asst('k1m', Date.now(), [0, 55, 0, 0]));
  const start = Date.now() - 4000;
  const p = fakeClaude('crash', start);
  await hook({ hook_event_name: 'SessionStart', session_id: 'crash', transcript_path: tr, cwd: repo, source: 'startup' });
  await waitFor(() => discord.last() && discord.last().activity, 15000, 'first activity');
  const pid1 = status().daemonPid;
  assert.strictEqual(fs.statSync(env.CDP_PIPE_NAME).mode & 0o777, 0o600, 'socket private to the user');
  process.kill(pid1, 'SIGKILL');
  await sleep(300);
  assert.ok(fs.lstatSync(env.CDP_PIPE_NAME).isSocket(), 'socket file orphaned');
  const startedBefore = (logText().match(/daemon started/g) || []).length;
  discord.activities = [];
  await Promise.all(Array.from({ length: 6 }, () => hook({ hook_event_name: 'UserPromptSubmit', session_id: 'crash', transcript_path: tr, cwd: repo, prompt: 'x' })));
  await waitFor(daemonAlive, 10000, 'new daemon');
  await sleep(1500);
  assert.strictEqual((logText().match(/daemon started/g) || []).length, startedBefore + 1, 'exactly one new daemon');
  assert.strictEqual((logText().match(/removed a stale socket/g) || []).length >= 1, true);
  const a = await waitFor(() => discord.last() && discord.last().activity, 15000, 'activity after recovery');
  assert.strictEqual(a.timestamps.start, start, 'timer survives the daemon crash (registry)');
  assert.notStrictEqual(status().daemonPid, pid1);
  p.kill('SIGKILL');
  await waitFor(async () => !(await daemonAlive()), 15000, 'daemon exits');
  assert.ok(!fs.existsSync(env.CDP_PIPE_NAME), 'own socket removed at shutdown');
  await discord.stop();
});

test('Discord socket in a non-first directory and index (e.g. TMPDIR differs from Discord\'s)', { timeout: 60000, skip: ONLY_POSIX }, async () => {
  await freshStart();
  const dirs = [path.join(sockDir, 'a'), path.join(sockDir, 'b')]; dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));
  const saved = env.CDP_DISCORD_PIPE_PREFIX;
  delete env.CDP_DISCORD_PIPE_PREFIX; env.CDP_DISCORD_IPC_DIRS = dirs.join(path.delimiter);
  try {
    const discord = new FakeDiscord(); await discord.start(path.join(dirs[1], 'discord-ipc-3'));
    const repo = path.join(tmp, 'dirs-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const tr = path.join(tmp, 'projects', 'dirs.jsonl'); fs.writeFileSync(tr, asst('d1m', Date.now(), [0, 9, 0, 0]));
    const p = fakeClaude('dirs', Date.now() - 1000);
    await hook({ hook_event_name: 'SessionStart', session_id: 'dirs', transcript_path: tr, cwd: repo, source: 'startup' });
    const a = await waitFor(() => discord.last() && discord.last().activity, 15000, 'activity via b/discord-ipc-3');
    assert.strictEqual(a.details, 'Projekt: dirs-repo');
    p.kill('SIGKILL');
    await waitFor(async () => !(await daemonAlive()), 15000, 'daemon exits');
    await discord.stop();
  } finally { env.CDP_DISCORD_PIPE_PREFIX = saved; delete env.CDP_DISCORD_IPC_DIRS; }
});

test('Claude desktop on macOS (watcher format): hidden/minimized/unknown keep the card, only a closed window hides it', { timeout: 60000 }, async () => {
  await freshStart();
  const winFile = path.join(tmp, 'window-state-mac.json');
  const setRaw = raw => fs.writeFileSync(winFile, JSON.stringify({ mac_raw: raw }));
  setRaw({ running: true, onscreen: 1, ax: { status: 'off' } });
  env.CDP_WINDOW_STATE_FILE = winFile;
  try {
    const discord = new FakeDiscord(); await discord.start();
    const repo = path.join(tmp, 'mac-desk'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const tr = path.join(tmp, 'projects', 'md.jsonl'); fs.writeFileSync(tr, asst('md1', Date.now(), [0, 5, 0, 0]));
    const start = Date.now() - 1500;
    const p = fakeClaude('md', start);
    fs.writeFileSync(path.join(env.CDP_CLAUDE_DIR, 'sessions', `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId: 'md', startedAt: start, entrypoint: 'claude-desktop' }));
    await hook({ hook_event_name: 'SessionStart', session_id: 'md', transcript_path: tr, cwd: repo, source: 'startup' });
    await waitFor(() => discord.last() && discord.last().activity && discord.last().activity.details === 'Projekt: mac-desk', 15000, 'open');
    for (const raw of [{ running: true, onscreen: 0, hidden: true }, { running: true, onscreen: 0, ax: { status: 'off' } }, { running: true, onscreen: 0, ax: { status: 'denied', code: '-1743' } }, { running: true, onscreen: 0, ax: { status: 'ok', windows: [{ minimized: true }] } }]) {
      setRaw(raw); await sleep(1200);
      assert.ok(discord.last().activity, `kept for ${JSON.stringify(raw)}`);
    }
    setRaw({ running: true, onscreen: 0, ax: { status: 'ok', windows: [] } });
    await waitFor(() => discord.last().activity === null, 15000, 'hidden when closed').catch(e => { console.error(JSON.stringify(status(), null, 1).slice(0, 3000)); throw e; });
    assert.strictEqual(status().claudeApp.mac.state, 'closed');
    setRaw({ running: true, onscreen: 1, ax: { status: 'ok', windows: [{ minimized: false }], mode: 'code' } });
    const back = await waitFor(() => { const l = discord.last(); return l.activity && l; }, 15000, 'back');
    assert.strictEqual(back.activity.timestamps.start, start);
    p.kill('SIGKILL');
    await waitFor(async () => !(await daemonAlive()), 15000, 'daemon exits');
    await discord.stop();
  } finally { delete env.CDP_WINDOW_STATE_FILE; }
});

test('install → reinstall (idempotent) → autostart paths → hook via shell → uninstall, awkward home path', { timeout: 90000 }, async () => {
  const WEIRD = IS_WIN ? `Zoë's dir $x & y` : `Zoë's "home" $x \`y\` !z & w; ż`;
  const home = path.join(tmp, WEIRD);
  const claudeDir = path.join(home, '.claude');
  const inst = path.join(claudeDir, 'discord-presence');
  const settings = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  const foreign = { statusLine: { type: 'command', command: 'my-status.sh' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] }] } };
  fs.writeFileSync(settings, JSON.stringify(foreign));
  const agents = path.join(home, 'LaunchAgents'), startup = path.join(home, 'Startup');
  const ienv = { ...process.env, CDP_INSTALL_DIR: inst, CDP_SETTINGS: settings, CDP_CLAUDE_DIR: path.join(tmp, 'claude'), CDP_LAUNCH_AGENTS_DIR: agents, CDP_STARTUP_DIR: startup, CDP_LAUNCHCTL: 'none', CDP_FAST: '1' };
  delete ienv.CDP_DATA_DIR; delete ienv.CDP_PIPE_NAME; delete ienv.CDP_DISCORD_PIPE_PREFIX;
  ienv.CDP_DISCORD_IPC_DIRS = IS_WIN ? '' : path.join(sockDir, 'none'); // never reach a real Discord
  const run = (file, args = []) => require('child_process').spawnSync(process.execPath, [file, ...args], { env: ienv, encoding: 'utf8' });
  const r1 = run(path.join(__dirname, '..', 'install.js'), ['--app-id', '123456789012345678']);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const after1 = fs.readFileSync(settings, 'utf8');
  const r2 = run(path.join(__dirname, '..', 'install.js'));
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /unchanged/);
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), after1, 'reinstall leaves settings.json byte-identical');
  const data = JSON.parse(after1);
  assert.strictEqual(S.countOurs(data), 7);
  assert.deepStrictEqual(data.statusLine, foreign.statusLine);
  assert.deepStrictEqual(data.hooks.PreToolUse[0], foreign.hooks.PreToolUse[0], 'foreign PreToolUse hook kept, first');
  assert.ok(data.hooks.PreToolUse.slice(1).every(g => g.hooks.every(h => S.isOurs(h) && h.async === true)), 'only our async hook added');
  assert.deepStrictEqual(data.hooks.SessionStart[0], foreign.hooks.SessionStart[0]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(inst, 'config.json'), 'utf8')).applicationId, '123456789012345678', 'Application ID kept across reinstall');
  // autostart enabled → reinstall writes the launcher with the installed paths
  const cfgF = path.join(inst, 'config.json');
  fs.writeFileSync(cfgF, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgF, 'utf8')), autostart: true }));
  assert.strictEqual(run(path.join(__dirname, '..', 'install.js')).status, 0);
  const A = require('../app/lib/autostart');
  const launcher = IS_WIN ? path.join(startup, A.FILE_NAME) : process.platform === 'darwin' ? path.join(agents, `${A.LABEL}.plist`) : null;
  if (launcher) {
    assert.ok(fs.existsSync(launcher), 'launcher written');
    if (process.platform === 'darwin') {
      const { execFileSync } = require('child_process');
      assert.strictEqual(execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.1', 'raw', launcher], { encoding: 'utf8' }).trim(), path.join(inst, 'daemon.js'));
    }
  }
  fs.writeFileSync(cfgF, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgF, 'utf8')), autostart: false }));
  // the installed SessionStart command, executed exactly as Claude Code does on macOS/Linux
  if (!IS_WIN) {
    const cmd = data.hooks.SessionStart[1].hooks[0].command;
    const repo = path.join(tmp, 'inst-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const p = fakeClaude('inst1', Date.now());
    const h = require('child_process').spawnSync('/bin/sh', ['-c', cmd], { env: ienv, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'inst1', cwd: repo, source: 'startup' }), encoding: 'utf8' });
    assert.strictEqual(h.status, 0); assert.strictEqual(h.stdout + h.stderr, '');
    const st = await waitFor(() => { const o = JSON.parse(run(path.join(inst, 'cli.js'), ['status', '--json']).stdout); return o.daemonRunning && o; }, 15000, 'installed daemon via hook');
    const sock = (() => { const v = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).pipeName())', path.join(inst, 'lib', 'common.js')], { env: ienv, encoding: 'utf8' }).stdout; return v; })();
    extraDaemons.push(sock);
    assert.ok(Buffer.byteLength(sock) <= 103, `socket path fits sun_path: ${sock}`);
    assert.ok(st.status && st.status.daemonPid);
    p.kill('SIGKILL');
  }
  const u = run(path.join(inst, 'uninstall.js'));
  assert.strictEqual(u.status, 0, u.stderr);
  const left = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepStrictEqual(left, foreign, 'only our hooks removed');
  assert.ok(!fs.existsSync(inst), 'install directory removed');
  if (launcher) assert.ok(!fs.existsSync(launcher), 'launcher removed');
  assert.ok(fs.readdirSync(path.join(claudeDir, 'backups')).length >= 2, 'backups kept');
});

test('resumed session in a new Claude process: a stale <pid>.json of the dead process is ignored, a running session follows the new process', { timeout: 60000 }, async () => {
  await freshStart();
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'resume-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'rs1.jsonl'); fs.writeFileSync(tr, asst('rs1m', Date.now(), [0, 300, 0, 0]));
  const sessionsDir = path.join(env.CDP_CLAUDE_DIR, 'sessions');

  // 1) Claude restarted and resumed the conversation: the old process's entry is still there
  const deadPid = 999990 + Math.floor(Math.random() * 9);
  const t0 = Date.now() - 600000;
  fs.writeFileSync(path.join(sessionsDir, `${deadPid}.json`), JSON.stringify({ pid: deadPid, sessionId: 'rs1', startedAt: t0 }));
  const start1 = Date.now() - 5000;
  const p1 = fakeClaude('rs1', start1);
  await hook({ hook_event_name: 'SessionStart', session_id: 'rs1', transcript_path: tr, cwd: repo, source: 'resume' });
  const a1 = await waitFor(() => { const l = discord.last(); return l && l.activity && l.activity.details === 'Projekt: resume-repo' && l; }, 15000, 'resumed session shown');
  assert.strictEqual(a1.activity.timestamps.start, start1, 'timer from the live process, not the stale entry');
  const s1 = sessionsInStatus().find(s => s.id === 'rs1');
  assert.ok(s1 && s1.pid === p1.pid, `bound to the live process (got ${s1 && s1.pid})`);

  // 2) the conversation is resumed in yet another process while the first one exits
  const start2 = Date.now();
  const p2 = fakeClaude('rs1', start2);
  p1.kill('SIGKILL');
  const a2 = await waitFor(() => { const l = discord.last(); return l && l.activity && l.activity.timestamps.start === start2 && l; }, 15000, 'followed the new process');
  assert.strictEqual(a2.activity.details, 'Projekt: resume-repo');
  assert.ok(sessionsInStatus().some(s => s.id === 'rs1' && s.pid === p2.pid));

  // 3) no live process left for the conversation → closed
  p2.kill('SIGKILL');
  await waitFor(() => discord.last().activity === null, 15000, 'cleared');
  try { fs.rmSync(path.join(sessionsDir, `${deadPid}.json`)); } catch {}
  await waitFor(async () => !(await daemonAlive()), 15000, 'daemon exits');
  await discord.stop();
});

test('activity line: Thinking → Editing files → Running commands → Waiting; categories only, never tool input; off → plain Working', { timeout: 60000 }, async () => {
  await freshStart();
  setCfg({ language: 'en', showStatus: true, showActivity: true, largeImageKey: 'https://example.test/big.png', assetBaseUrl: 'https://example.test/assets' });
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'act-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'act1.jsonl'); fs.writeFileSync(tr, asst('act1m', Date.now(), [0, 200, 0, 0]));
  const p = fakeClaude('act1', Date.now() - 1000);
  const last = () => discord.last() && discord.last().activity;
  const base = { session_id: 'act1', transcript_path: tr, cwd: repo };
  const stateIs = (prefix, what) => waitFor(() => { const a = last(); return a && a.state && a.state.startsWith(prefix) && a; }, 15000, what);

  await hook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await stateIs('Waiting · ', 'Waiting');
  await hook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'p' });
  await stateIs('Thinking · ', 'Thinking');
  await sleep(400);
  await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\secret\\plan-SECRETFILE.md', old_string: 'SECRETTEXT' } });
  const e = await stateIs('Editing files · ', 'Editing files');
  assert.strictEqual(e.assets.small_text, 'Claude: editing files…');
  await sleep(400);
  await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo SECRETCMD' } });
  await stateIs('Running commands · ', 'Running commands');
  await hook({ ...base, hook_event_name: 'Stop' });
  await stateIs('Waiting · ', 'Waiting after Stop');
  for (const a of discord.activities) assert.ok(!/SECRET/.test(JSON.stringify(a)), 'tool input never reaches Discord');
  for (const f of ['registry.json', 'status.json']) { try { assert.ok(!/SECRET/.test(fs.readFileSync(path.join(env.CDP_DATA_DIR, 'state', f), 'utf8')), f); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
  assert.ok(!/SECRET/.test(logText()), 'nor the log');

  // activity line off: the hook exits early and the card says plain "Working"
  setCfg({ showActivity: false });
  await sleep(700);
  await hook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'q' });
  await stateIs('Working · ', 'plain Working');
  await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} });
  await sleep(1500);
  assert.ok(last().state.startsWith('Working · '), 'no activity with showActivity off');

  p.kill('SIGKILL');
  await waitFor(() => discord.last().activity === null, 15000, 'cleared');
  await discord.stop();
});

test('macOS/Linux: a slow ps result for the old PID does not drop a session that just moved to a new process', { timeout: 60000, skip: ONLY_POSIX }, async () => {
  await freshStart();
  // a slow ps: marks when it was asked, waits, then answers – for the PIDs asked at that time
  const slowPs = path.join(tmp, 'slow-ps.sh');
  const marker = path.join(tmp, 'ps-asked');
  fs.writeFileSync(slowPs, `#!/bin/sh\ntouch '${marker}'\nsleep 2\nexec /bin/ps "$@"\n`);
  fs.chmodSync(slowPs, 0o755);
  env.CDP_PS = slowPs;
  const discord = new FakeDiscord(); await discord.start();
  try {
    const repo = path.join(tmp, 'psrace-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const tr = path.join(tmp, 'projects', 'psr1.jsonl'); fs.writeFileSync(tr, asst('psr1m', Date.now(), [0, 100, 0, 0]));
    const p1 = fakeClaude('psr1', Date.now() - 5000);
    await hook({ hook_event_name: 'SessionStart', session_id: 'psr1', transcript_path: tr, cwd: repo, source: 'startup' });
    await waitFor(() => { const l = discord.last(); return l && l.activity && l.activity.details === 'Projekt: psrace-repo'; }, 15000, 'shown');
    // wait for a ps check that is still running, then resume in a new process and end the old one
    try { fs.rmSync(marker); } catch {}
    await waitFor(() => fs.existsSync(marker), 15000, 'ps asked');
    const start2 = Date.now();
    const p2 = fakeClaude('psr1', start2);
    p1.kill('SIGKILL');
    await waitFor(() => sessionsInStatus().some(s => s.id === 'psr1' && s.pid === p2.pid), 15000, 'rebound to the new process');
    await sleep(3500); // the slow ps answers (old PID only) – the session must survive
    assert.ok(sessionsInStatus().some(s => s.id === 'psr1' && s.pid === p2.pid), 'session still bound to the new process');
    assert.ok(!/process gone \d+ session psr1/.test(logText().split('session moved to a new process').pop()), 'not dropped after the move');
    assert.strictEqual(discord.last().activity && discord.last().activity.timestamps.start, start2);
    p2.kill('SIGKILL');
    await waitFor(() => discord.last().activity === null, 15000, 'cleared');
  } finally {
    delete env.CDP_PS;
    await discord.stop();
  }
});

test('late async PreToolUse (started before Stop, stdin delayed until after it) never reopens the ended turn; a new prompt id does', { timeout: 60000 }, async () => {
  await freshStart();
  setCfg({ language: 'en', showStatus: true, showActivity: true, largeImageKey: 'none' });
  const discord = new FakeDiscord(); await discord.start();
  const repo = path.join(tmp, 'late-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const tr = path.join(tmp, 'projects', 'late1.jsonl'); fs.writeFileSync(tr, asst('late1m', Date.now(), [0, 100, 0, 0]));
  const p = fakeClaude('late1', Date.now() - 1000);
  const base = { session_id: 'late1', transcript_path: tr, cwd: repo };
  const last = () => discord.last() && discord.last().activity;
  const stateIs = (prefix, what) => waitFor(() => { const a = last(); return a && a.state && a.state.startsWith(prefix) && a; }, 15000, what);
  const registryOf = () => { try { return JSON.parse(fs.readFileSync(path.join(env.CDP_DATA_DIR, 'state', 'registry.json'), 'utf8')).sessions.find(s => s.id === 'late1'); } catch { return null; } };

  await hook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x', prompt_id: 'P1' });
  await stateIs('Thinking · ', 'Thinking');

  // the tool hook process starts first, but its stdin only arrives after Stop has finished
  const late = spawn(process.execPath, [path.join(APP, 'hook.js'), 'PreToolUse'], { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  late.stdin.on('error', () => {});
  const lateDone = new Promise(r => late.on('close', r));
  await sleep(300);
  // Stop runs to completion first (its event is recorded first), then the late hook gets its
  // input – within the hook's own 4 s limit – and records a NEWER time stamp than Stop
  await hook({ ...base, hook_event_name: 'Stop', prompt_id: 'P1' });
  late.stdin.end(JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, prompt_id: 'P1' }));
  await lateDone;
  await stateIs('Waiting · ', 'Waiting after Stop');
  await sleep(2000);
  assert.ok(last().state.startsWith('Waiting · '), `late hook of the ended turn reopened it: ${last().state}`);
  assert.strictEqual(registryOf().status, 'waiting');

  // no prompt id (older Claude Code): cannot tell, so it does not reopen either
  await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
  await sleep(1500);
  assert.ok(last().state.startsWith('Waiting · '), 'no prompt id → stays waiting');

  // Claude continues on its own with a new prompt id → working again
  await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, prompt_id: 'P2' });
  await stateIs('Reading code · ', 'new prompt reopens');

  // a permission prompt pauses the turn; the same prompt's next tool resumes it
  await hook({ ...base, hook_event_name: 'Notification', message: 'needs permission', prompt_id: 'P2' });
  await stateIs('Waiting · ', 'Waiting on Notification');
  await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, prompt_id: 'P2' });
  await stateIs('Running commands · ', 'resumed after permission');

  // while working on a new prompt, a late hook of an older prompt does not change the activity
  await hook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'y', prompt_id: 'P3' });
  await stateIs('Thinking · ', 'Thinking P3');
  await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, prompt_id: 'P2' });
  await sleep(1500);
  assert.ok(last().state.startsWith('Thinking · '), `older prompt changed the activity: ${last().state}`);

  p.kill('SIGKILL');
  await waitFor(() => discord.last().activity === null, 15000, 'cleared');
  await discord.stop();
});
