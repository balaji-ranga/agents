/**
 * Ensure every agent in openclaw.json has browser in tools.allow (global + per-agent).
 * Run: node scripts/ensure-browser-all-agents.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const homedir = process.env.USERPROFILE || process.env.HOME || '';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(homedir, '.openclaw', 'openclaw.json');

let config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if (!config.browser) config.browser = { enabled: true, defaultProfile: 'openclaw' };
config.browser.enabled = true;
config.browser.defaultProfile = config.browser.defaultProfile || 'openclaw';

if (!config.tools) config.tools = {};
if (!Array.isArray(config.tools.allow)) config.tools.allow = [];
if (!config.tools.allow.includes('browser')) config.tools.allow.push('browser');

for (const a of config.agents?.list || []) {
  a.tools = a.tools || {};
  const allow = Array.isArray(a.tools.allow) ? a.tools.allow : [];
  if (!allow.includes('browser')) allow.push('browser');
  a.tools.allow = allow;
}

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
console.log('browser enabled for', (config.agents?.list || []).length, 'agents in', CONFIG_PATH);
