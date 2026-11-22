#!/usr/bin/env node
'use strict';
// User commands: status/diagnostics, enable/disable, aliases, Application ID.
const fs = require('fs');
const net = require('net');
const C = require('./lib/common');
const { SessionUsage, aggregate, countFor } = require('./lib/tokens');
const { findProjectRoot, displayName } = require('./lib/project');

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

(async () => {
  switch (cmd) {
    case 'status': case 'diag': case 'diagnose': {
      const alive = (await send('ping')) === 'pong';
      const st = C.readJson(C.P.status, null);
      const cfg = C.loadConfig();
      if (args.includes('--json')) { console.log(JSON.stringify({ daemonRunning: alive, config: cfg, status: st }, null, 2)); break; }
      console.log(`Integration: ${cfg.enabled ? 'enabled' : 'DISABLED'}`);
      console.log(`Application ID: ${cfg.applicationId ? cfg.applicationId : 'MISSING – run: node cli.js set-app-id <ID>'}`);
      console.log(`Background process: ${alive ? `running (PID ${st && st.daemonPid})` : 'not running (starts on the next Claude event)'}`);
      if (!alive || !st || !st.daemonPid) break;
      if (st.claudeApp) console.log(`Claude app: window ${st.claudeApp.windowVisible ? 'visible' : 'hidden/closed'}, tab: ${st.claudeApp.tab}${st.claudeApp.showingChat ? ' → showing the chat activity' : ''}`);
      console.log(`Discord: ${st.discord.state}${st.discord.error ? ` (${st.discord.error})` : ''}${st.discord.state === 'waiting' ? `, retry at ${st.discord.nextRetryAt}` : ''}`);
      console.log(`\nSessions (${st.sessions.length}):`);
      for (const s of st.sessions) console.log(`  ${s.id === (st.active && st.active.sessionId) ? '*' : ' '} ${s.id.slice(0, 8)}  PID ${s.pid || '?'} (${s.pidVia || 'none'})  project: ${s.project === null ? '[hidden]' : s.project}  window: ${s.window || 'n/a'}  last activity: ${s.lastActivity || '-'}`);
      console.log('\nActivity payload (sent to Discord via SET_ACTIVITY):');
      console.log(JSON.stringify(st.activityPayload, null, 2));
      console.log(`Last payload confirmed by Discord: ${st.sentToDiscord ? 'yes' : 'no'}`);
      if (st.active) {
        const ts = st.active.tokenSource;
        console.log(`\nToken source: ${ts.kind}, mode "${ts.mode}", scope "${ts.scope}", subagents: ${ts.includeSubagents ? 'yes' : 'no'}`);
        console.log(`Launch time (Discord timer start): ${st.active.runStart}`);
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
