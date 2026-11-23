#!/usr/bin/env node
'use strict';
// User commands: status/diagnostics, enable/disable, aliases, Application ID.
const fs = require('fs');
const net = require('net');
const C = require('./lib/common');
const { SessionUsage, aggregate, countFor } = require('./lib/tokens');
const { findProjectRoot, displayName } = require('./lib/project');
const path = require('path');
const autostart = require('./lib/autostart');

const [cmd, ...args] = process.argv.slice(2);

function editConfig(fn) {
  const cur = C.readJson(C.P.config, {}) || {};
  fn(cur);
  C.writeJsonAtomic(C.P.config, cur);
}

function send(msg) {
  return new Promise(resolve => {
    const s = net.createConnection(C.pipeName());
    let out = '';
    const t = setTimeout(() => { s.destroy(); resolve(null); }, 1500);
    s.on('connect', () => s.write(msg + '\n'));
    s.on('data', d => { out += d; });
    s.on('close', () => { clearTimeout(t); resolve(out.trim() || null); });
    s.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

function fmtT(t) {
  const models = Object.entries(t.models || {}).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ');
  return `input ${t.input}, output ${t.output}, cache read ${t.cacheRead}, cache creation ${t.cacheCreation}  (API responses: ${t.messages}, subagents: ${t.subagentMessages})\n                      est. cost $${(t.costUsd || 0).toFixed(4)}${models ? ` [${models}]` : ''}${t.unpricedMessages ? `, ${t.unpricedMessages} responses with unknown price (${t.unpricedModels.join(', ')})` : ''}`;
}

const help = `Discord Rich Presence for Claude Code

  node cli.js status              integration state, exact activity payload and token source
  node cli.js status --json       same, as JSON
  node cli.js disable             turn off (clears the Discord activity, stops the background process)
  node cli.js enable              turn back on (starts on the next Claude event)
  node cli.js set-app-id <ID>     save the Application ID from the Discord Developer Portal
  node cli.js alias <folder> <alias>   custom project name (folder = directory name or full path)
  node cli.js unalias <folder>
  node cli.js hide [<folder>]     hide the project name (no argument = all projects)
  node cli.js unhide [<folder>]
  node cli.js language <en|pl>    language of the text shown on Discord
  node cli.js image <key|url|auto|none>   large image: Art Asset key, image URL, app icon (auto) or none
  node cli.js type <watching|playing|competing|listening>   activity type (watching = below the VS Code extension)
  node cli.js status-icon <on|off>   show whether Claude is working or waiting for you
  node cli.js model <on|off>       show the model and effort in the image tooltip
  node cli.js today <rotate|tooltip|off>   today's totals across all sessions
  node cli.js link <folder> [url]  add a button (e.g. View on GitHub) for a project; no url = read the Git remote
  node cli.js unlink <folder>
  node cli.js autostart <on|off>   start at sign-in (Windows: Startup folder, macOS: LaunchAgent)
  node cli.js mac-accessibility <on|off>   macOS: use Accessibility to tell minimized windows from closed ones
  node cli.js version              installed version and the latest release on GitHub
  node cli.js update [--force]     install the latest release from GitHub (keeps your config)
  node cli.js update --main        install the main branch (unreleased changes)
  node cli.js update <version>     install that release, e.g. update 1.1.0 (also to go back)
  node cli.js activity <on|off>    show what Claude is doing (Editing files, Running commands…)
  node cli.js update-check <on|off>   check GitHub once a day for a newer release
  node cli.js chat <on|off>       also show an activity while the regular Claude chat tab is open
  node cli.js cost <on|off>       show the estimated API-price cost next to the tokens
  node cli.js tokens <all|no_cache_read|output>   what the token counter includes
  node cli.js scope <launch|conversation>         since Claude was launched / whole conversation
  node cli.js count <file.jsonl> [since-ISO]      count tokens in a transcript (verification)
  node cli.js project [dir]       which project name Discord will see
  node cli.js stop                stop the background process (restarts on the next Claude event)
  node cli.js logs                recent log entries
`;

const fail = msg => { console.error(msg); process.exit(1); };

// https URL of a repository's "origin" remote (git@github.com:a/b.git → https://github.com/a/b)
function gitRemoteUrl(dir) {
  try {
    const r = findProjectRoot(dir);
    if (!r || !r.git) return null;
    let gitDir = path.join(r.root, '.git');
    const conf = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const m = /\[remote "origin"\][^\[]*?url\s*=\s*(\S+)/.exec(conf);
    if (!m) return null;
    let u = m[1].trim();
    const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(u);
    if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
    u = u.replace(/^https:\/\/[^@/]+@/, 'https://').replace(/\.git$/, ''); // never keep credentials
    return /^https:\/\//.test(u) ? u : null;
  } catch { return null; }
}

async function update(argv) {
  const force = argv.includes('--force');
  const rest = argv.filter(a => a !== '--force');
  const ref = rest.includes('--main') ? 'main' : (rest.find(a => !a.startsWith('-')) || 'release');
  let r;
  try {
    r = await require('./lib/updater').update({ repo: C.loadConfig().updateRepo, appDir: C.P.app, ref, force, nodePath: require('./lib/nodepath').stableNodePath() });
  } catch (e) { fail(`Update failed: ${e.message}`); }
  if (r && r.status === 'updated') {
    try { fs.rmSync(path.join(C.P.data, 'state', 'update-check.json'), { force: true }); } catch {}
    console.log(`Updated to ${r.label}. Restart open Claude Code sessions if the hooks changed.`);
  }
}

async function showVersion(argv) {
  const V = require('./lib/version');
  const cfg = C.loadConfig();
  const installed = V.installedVersion(C.P.app);
  console.log(`Installed: ${installed || 'unknown (installed before versions were recorded)'}`);
  const r = await V.checkForUpdate({ repo: cfg.updateRepo, cacheFile: path.join(C.P.data, 'state', 'update-check.json'), installed, force: true });
  if (r.error && !r.latest) { console.log(`Latest release: could not check (${r.error})`); return; }
  console.log(`Latest release: ${r.latest}${r.url ? `  ${r.url}` : ''}`);
  if (r.updateAvailable) console.log('A newer version is available – run: node cli.js update');
  else if (installed && r.latest && V.compare(installed, r.latest) > 0) console.log('This build is newer than the latest release (unreleased changes).');
  else console.log('You have the latest release.');
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
}

(async () => {
  switch (cmd) {
    case 'status': case 'diag': case 'diagnose': {
      const alive = (await send('ping')) === 'pong';
      const st = C.readJson(C.P.status, null);
      const cfg = C.loadConfig();
      if (args.includes('--json')) { console.log(JSON.stringify({ daemonRunning: alive, config: cfg, status: st }, null, 2)); break; }
      console.log(`Integration: ${cfg.enabled ? 'enabled' : 'DISABLED'}   version: ${require('./lib/version').installedVersion(C.P.app) || 'unknown'}`);
      if (st && st.update && st.update.updateAvailable) console.log(`Update available: ${st.update.latest} (installed ${st.update.installed}) – run: node cli.js update`);
      console.log(`Application ID: ${cfg.applicationId ? cfg.applicationId : 'MISSING – run: node cli.js set-app-id <ID>'}`);
      console.log(`Autostart at sign-in: ${autostart.isEnabled() ? `on (${autostart.filePath()})` : 'off'}`);
      if (process.platform === 'darwin') console.log(`Claude desktop detection (macOS): app running/hidden/window on screen – always; minimized vs closed – ${cfg.macAccessibility ? 'via Accessibility (requested)' : 'unavailable (mac-accessibility off)'}; Code/chat tab – not detectable on macOS`);
      console.log(`Background process: ${alive ? `running (PID ${st && st.daemonPid})` : 'not running (starts on the next Claude event)'}`);
      if (!alive || !st || !st.daemonPid) break;
      if (st.claudeApp && st.claudeApp.mac) console.log(`Claude app (macOS): ${st.claudeApp.mac.state}, tab: ${st.claudeApp.mac.mode || 'unknown'}, Accessibility: ${st.claudeApp.mac.accessibility}${st.claudeApp.showingChat ? ' → showing the chat activity' : ''}`);
      else if (st.claudeApp) console.log(`Claude app: window ${st.claudeApp.windowVisible ? 'visible' : 'hidden/closed'}, tab: ${st.claudeApp.tab}${st.claudeApp.showingChat ? ' → showing the chat activity' : ''}`);
      console.log(`Discord: ${st.discord.state}${st.discord.error ? ` (${st.discord.error})` : ''}${st.discord.state === 'waiting' ? `, retry at ${st.discord.nextRetryAt}` : ''}`);
      console.log(`\nSessions (${st.sessions.length}):`);
      for (const s of st.sessions) console.log(`  ${s.id === (st.active && st.active.sessionId) ? '*' : ' '} ${s.id.slice(0, 8)}  PID ${s.pid || '?'} (${s.pidVia || 'none'})  project: ${s.project === null ? '[hidden]' : s.project}  window: ${s.window || 'n/a'}  last activity: ${s.lastActivity || '-'}`);
      console.log('\nActivity payload (sent to Discord via SET_ACTIVITY):');
      console.log(JSON.stringify(st.activityPayload, null, 2));
      console.log(`Last payload confirmed by Discord: ${st.sentToDiscord ? 'yes' : 'no'}`);
      if (st.active && st.active.tokenSource) {
        const ts = st.active.tokenSource;
        console.log(`\nToken source: ${ts.kind}, mode "${ts.mode}", scope "${ts.scope}", subagents: ${ts.includeSubagents ? 'yes' : 'no'}`);
        console.log(`Launch time (Discord timer start): ${st.active.runStart}`);
        console.log(`Claude state: ${st.active.claudeState}   model: ${st.active.model || '-'}   effort: ${st.active.effort || '-'}${st.active.link ? `   button: ${st.active.link}` : ''}`);
        if (st.active.today) console.log(`Today (${st.active.today.files} transcripts): ${fmtT(st.active.today)}`);
        for (const f of ts.files) console.log(`  ${f.kind.padEnd(8)} ${f.exists ? '' : '[MISSING] '}${f.file}  lines: ${f.lines}, malformed: ${f.badLines}`);
        console.log(`  unique responses: ${ts.uniqueMessages}, duplicate lines collapsed: ${ts.duplicateLinesCollapsed}, /compact boundaries: ${ts.compactBoundariesSeen}`);
        console.log(`  since launch:       ${fmtT(ts.sinceLaunch)}`);
        console.log(`  whole conversation: ${fmtT(ts.conversationTotal)}`);
        console.log(`  published:          ${ts.published === null ? 'no data' : ts.published}${ts.cost && ts.cost.published ? `, cost ${ts.cost.published} (${ts.cost.basis}, prices as of ${ts.cost.pricesDate})` : ''}`);
      }
      break;
    }
    case 'disable':
      editConfig(c => { c.enabled = false; });
      await send('stop');
      console.log('Integration disabled. The Discord activity has been cleared.');
      break;
    case 'enable':
      editConfig(c => { c.enabled = true; });
      console.log('Integration enabled – it starts on the next Claude event (session start or prompt).');
      break;
    case 'set-app-id': {
      const id = (args[0] || '').trim();
      if (!/^\d{15,22}$/.test(id)) fail('The Application ID is a 17–20 digit number from Discord Developer Portal → General Information.');
      editConfig(c => { c.applicationId = id; });
      console.log('Application ID saved.');
      break;
    }
    case 'alias':
      if (args.length < 2) fail('Usage: alias <folder> <alias>');
      editConfig(c => { c.aliases = c.aliases || {}; c.aliases[args[0]] = args.slice(1).join(' '); });
      console.log(`Alias saved: ${args[0]} → ${args.slice(1).join(' ')}`);
      break;
    case 'unalias':
      editConfig(c => { if (c.aliases) delete c.aliases[args[0]]; });
      console.log('Alias removed.');
      break;
    case 'hide':
      editConfig(c => { if (args[0]) { c.hiddenProjects = [...new Set([...(c.hiddenProjects || []), args[0]])]; } else c.hideProject = true; });
      console.log(args[0] ? `Project ${args[0]} will be hidden.` : 'All project names will be hidden.');
      break;
    case 'unhide':
      editConfig(c => { if (args[0]) c.hiddenProjects = (c.hiddenProjects || []).filter(h => h !== args[0]); else c.hideProject = false; });
      console.log('Done.');
      break;
    case 'language': case 'lang':
      if (!['en', 'pl'].includes(args[0])) fail('Usage: language <en|pl>');
      editConfig(c => { c.language = args[0]; }); console.log('Done.');
      break;
    case 'image': {
      const v = (args[0] || '').trim();
      if (!v) fail('Usage: image <key|url|auto|none>');
      editConfig(c => { c.largeImageKey = v === 'auto' ? '' : v; });
      console.log(v === 'auto' ? 'The application icon from the Developer Portal will be used.' : v === 'none' ? 'No image.' : `Image set to: ${v}`);
      break;
    }
    case 'type': {
      const types = ['watching', 'playing', 'competing', 'listening'];
      if (!types.includes(args[0])) fail(`Usage: type <${types.join('|')}>`);
      editConfig(c => { c.activityType = args[0]; }); console.log('Done.');
      break;
    }
    case 'status-icon':
      if (!['on', 'off'].includes(args[0])) fail('Usage: status-icon <on|off>');
      editConfig(c => { c.showStatus = args[0] === 'on'; }); console.log('Done.');
      break;
    case 'model':
      if (!['on', 'off'].includes(args[0])) fail('Usage: model <on|off>');
      editConfig(c => { c.showModel = args[0] === 'on'; }); console.log('Done.');
      break;
    case 'today':
      if (!['rotate', 'tooltip', 'off'].includes(args[0])) fail('Usage: today <rotate|tooltip|off>');
      editConfig(c => { c.showToday = args[0]; }); console.log('Done.');
      break;
    case 'link': {
      if (!args[0]) fail('Usage: link <folder-name-or-path> [https-url]');
      let url = args[1];
      if (!url) url = gitRemoteUrl(args[0]);
      if (!url || !/^https:\/\/\S+$/.test(url)) fail('Give an https:// URL, or a path to a Git repository with an https/ssh "origin" remote. Only link public pages.');
      const key = fs.existsSync(args[0]) ? path.basename(path.resolve(findProjectRoot(args[0]).root)) : args[0];
      editConfig(c => { c.links = c.links || {}; c.links[key] = url; });
      console.log(`Button for "${key}": ${url}\nNote: Discord shows buttons to other people, not on your own view of your profile.`);
      break;
    }
    case 'unlink':
      editConfig(c => { if (c.links) delete c.links[args[0]]; });
      console.log('Button removed.');
      break;
    case 'autostart': {
      if (!['on', 'off'].includes(args[0])) fail('Usage: autostart <on|off>');
      if (args[0] === 'on') {
        let f;
        try { f = autostart.enable(require('./lib/nodepath').stableNodePath(), path.join(C.P.app, 'daemon.js')); } catch (e) { fail(`Autostart not available: ${e.message}`); }
        editConfig(c => { c.autostart = true; });
        console.log(`Autostart on: ${f}\nThe background process now also starts at sign-in and stays running (it shows the chat tab without a Code session).`);
        const lc = autostart.enable.lastLaunchctl;
        if (lc && !lc.ok) console.log(`Note: launchctl could not load it now (${lc.error}); it will start at the next sign-in.`);
      } else {
        autostart.disable();
        editConfig(c => { c.autostart = false; });
        if (process.platform === 'darwin') console.log('LaunchAgent unloaded and removed (a standby process it started was stopped; the next Claude event starts it again if sessions are open).');
        console.log('Autostart off. The background process again exits ~20 s after the last Claude Code session.');
      }
      break;
    }
    case 'update': await update(args); break;
    case 'version': case '--version': case '-v': await showVersion(args); break;
    case 'activity':
      if (!['on', 'off'].includes(args[0])) fail('Usage: activity <on|off>');
      editConfig(c => { c.showActivity = args[0] === 'on'; }); console.log('Done.');
      break;
    case 'update-check':
      if (!['on', 'off'].includes(args[0])) fail('Usage: update-check <on|off>');
      editConfig(c => { c.checkUpdates = args[0] === 'on'; }); console.log('Done.');
      break;
    case 'mac-accessibility':
      if (!['on', 'off'].includes(args[0])) fail('Usage: mac-accessibility <on|off>');
      editConfig(c => { c.macAccessibility = args[0] === 'on'; });
      console.log(args[0] === 'on'
        ? 'Enabled. On the first check macOS may ask to let the app that started Claude (Terminal, iTerm, Claude…) control "System Events" and use Accessibility:\n  System Settings → Privacy & Security → Accessibility / Automation. If you refuse, the CLI presence keeps working; only the extra detection stays unavailable (see status).'
        : 'Disabled. Minimized and closed windows are not told apart on macOS.');
      break;
    case 'chat':
      if (!['on', 'off'].includes(args[0])) fail('Usage: chat <on|off>');
      editConfig(c => { c.showChat = args[0] === 'on'; }); console.log('Done.');
      break;
    case 'cost':
      if (!['on', 'off'].includes(args[0])) fail('Usage: cost <on|off>');
      editConfig(c => { c.showCost = args[0] === 'on'; }); console.log('Done.');
      break;
    case 'tokens':
      if (!['all', 'no_cache_read', 'output'].includes(args[0])) fail('Usage: tokens <all|no_cache_read|output>');
      editConfig(c => { c.tokenCount = args[0]; }); console.log('Done.');
      break;
    case 'scope':
      if (!['launch', 'conversation'].includes(args[0])) fail('Usage: scope <launch|conversation>');
      editConfig(c => { c.tokenScope = args[0]; }); console.log('Done.');
      break;
    case 'count': {
      if (!args[0]) fail('Usage: count <file.jsonl> [since-ISO]');
      const su = new SessionUsage(args[0], null, { includeSubagents: true });
      su.poll();
      const since = args[1] ? Date.parse(args[1]) : 0;
      const agg = aggregate([su], since, C.loadConfig().pricing);
      const cfg = C.loadConfig();
      console.log(`Files: ${[...su.tails.values()].map(t => `${t.kind}:${t.lines} lines`).join(', ')}`);
      console.log(`Unique API responses: ${su.messages.size}, duplicate lines collapsed: ${su.duplicateLines}, /compact boundaries: ${su.compactions}`);
      console.log(`Whole conversation: ${fmtT(agg.conversation)}`);
      if (since) console.log(`Since ${args[1]}: ${fmtT(agg.sinceLaunch)}`);
      const t = since ? agg.sinceLaunch : agg.conversation;
      const v = countFor(t, cfg.tokenCount);
      console.log(`Counter (${cfg.tokenCount}): ${v} → "${C.formatTokens(v, cfg.language)}"`);
      break;
    }
    case 'project': {
      const r = findProjectRoot(args[0] || process.cwd());
      console.log(`Project directory: ${r.root} (git: ${r.git})\nName on Discord: ${displayName(r.root, C.loadConfig()) ?? '[hidden]'}`);
      break;
    }
    case 'stop':
      console.log((await send('stop')) ? 'Stopped.' : 'The background process was not running.');
      break;
    case 'logs': {
      try { const l = fs.readFileSync(C.P.log, 'utf8').trimEnd().split('\n'); console.log(l.slice(-40).join('\n')); } catch { console.log('No logs yet.'); }
      break;
    }
    default:
      console.log(help);
  }
})();
