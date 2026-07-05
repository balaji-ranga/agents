#!/usr/bin/env node
/**
 * One-off: (1) Add tools.sessions.visibility=agent to ~/.openclaw/openclaw.json
 *         (2) Copy TechResearcher and ExpenseManager SOUL.md from templates to live workspaces.
 * Run from agent-os: node scripts/apply-session-visibility-and-souls.js
 */
const fs = require('fs');
const path = require('path');

const homedir = process.env.USERPROFILE || process.env.HOME || '';
const agentOsRoot = path.resolve(__dirname, '..');

// 1) Update openclaw.json
const configPath = path.join(homedir, '.openclaw', 'openclaw.json');
if (!fs.existsSync(configPath)) {
  console.error('Not found:', configPath);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!cfg.tools) cfg.tools = {};
cfg.tools.sessions = { visibility: 'agent' };
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
console.log('Updated', configPath, 'with tools.sessions.visibility=agent');

// 2) Copy SOUL.md to live workspaces (paths from typical openclaw config)
const copies = [
  {
    src: path.join(agentOsRoot, 'openclaw-workspace-templates', 'techresearcher', 'SOUL.md'),
    dest: path.join(homedir, '.openclaw', 'workspace-techresearcher', 'SOUL.md'),
  },
  {
    src: path.join(agentOsRoot, 'openclaw-workspace-templates', 'expensemanager', 'SOUL.md'),
    dest: path.join(homedir, '.openclaw', 'workspace-expenses', 'SOUL.md'),
  },
];
for (const { src, dest } of copies) {
  if (!fs.existsSync(src)) {
    console.warn('Skip (no template):', src);
    continue;
  }
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) {
    console.warn('Skip (workspace dir missing):', dir);
    continue;
  }
  fs.copyFileSync(src, dest);
  console.log('Copied SOUL.md ->', dest);
}

console.log('Done. Restart OpenClaw gateway (and backend/frontend if desired).');
