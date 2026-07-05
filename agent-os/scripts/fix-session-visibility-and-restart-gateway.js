#!/usr/bin/env node
/**
 * Set tools.sessions.visibility to "all" in ~/.openclaw/openclaw.json
 * so direct OpenClaw session chat can use sessions_history without forbidden.
 * Run from agent-os: node scripts/fix-session-visibility-and-restart-gateway.js
 * Then restart the gateway (e.g. .\scripts\stop-and-restart-gateway.ps1 or stop-and-restart-all.ps1).
 */
const fs = require('fs');
const path = require('path');

const homedir = process.env.USERPROFILE || process.env.HOME || '';
const configPath = path.join(homedir, '.openclaw', 'openclaw.json');

if (!fs.existsSync(configPath)) {
  console.error('Not found:', configPath);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!cfg.tools) cfg.tools = {};
if (!cfg.tools.sessions) cfg.tools.sessions = {};
cfg.tools.sessions.visibility = 'all';
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
console.log('Updated', configPath, 'with tools.sessions.visibility=all');
console.log('Restart the OpenClaw gateway so the config takes effect (e.g. .\\scripts\\stop-and-restart-all.ps1).');
