'use strict';
// What Claude is doing right now, from the PreToolUse hook's tool name. Only the category
// leaves this module – never the tool's input (file names, commands, URLs, queries).
const CATEGORIES = ['thinking', 'edit', 'read', 'run', 'web', 'agent', 'plan', 'tool'];

const EXACT = {
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read', NotebookRead: 'read',
  Bash: 'run', PowerShell: 'run', BashOutput: 'run', KillShell: 'run', KillBash: 'run', Monitor: 'run',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'agent', Agent: 'agent', SendMessage: 'agent', TaskOutput: 'agent', TaskStop: 'agent',
  TodoWrite: 'plan', TaskCreate: 'plan', TaskUpdate: 'plan', TaskList: 'plan', TaskGet: 'plan',
  EnterPlanMode: 'plan', ExitPlanMode: 'plan',
};

function categorize(toolName) {
  const t = String(toolName || '');
  if (!t) return null;
  if (EXACT[t]) return EXACT[t];
  if (/^mcp__/i.test(t)) {
    if (/browser|chrome|navigate|web_?fetch|web_?search|playwright|puppeteer/i.test(t)) return 'web';
    if (/update_plan|todo/i.test(t)) return 'plan';
    return 'tool';
  }
  return 'tool';
}

module.exports = { CATEGORIES, categorize };
