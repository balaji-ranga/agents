/**
 * Enable OpenClaw browser automation in ~/.openclaw/openclaw.json:
 * - browser.enabled + defaultProfile openclaw
 * - plugins.allow includes browser
 * - plugins.entries.browser.enabled
 * - tools.allow and per-agent tools.allow include "browser"
 *
 * Run: node scripts/enable-openclaw-browser.js
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(USERPROFILE, '.openclaw');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(OPENCLAW_DIR, 'openclaw.json');

let config = {};
if (existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not parse openclaw.json:', e.message);
    process.exit(1);
  }
}

if (!config.browser) config.browser = {};
config.browser.enabled = true;
config.browser.defaultProfile = config.browser.defaultProfile || 'openclaw';
if (!config.browser.profiles) {
  config.browser.profiles = {
    openclaw: { cdpPort: 18800, color: '#FF4500' },
  };
}

// Root browser block activates the bundled browser tool under restrictive plugins.allow.
// Do NOT add "browser" to plugins.allow — it is not a separate plugin id.

if (!config.tools) config.tools = {};
if (!Array.isArray(config.tools.allow)) config.tools.allow = [];
if (!config.tools.allow.includes('browser')) config.tools.allow.push('browser');

if (!config.skills) config.skills = {};
if (!config.skills.entries) config.skills.entries = {};
config.skills.entries['browser-automation'] = { enabled: true, ...config.skills.entries['browser-automation'] };

if (Array.isArray(config.agents?.list)) {
  for (const a of config.agents.list) {
    a.tools = a.tools || {};
    const allow = Array.isArray(a.tools.allow) ? a.tools.allow : [];
    if (!allow.includes('browser')) allow.push('browser');
    a.tools.allow = allow;
  }
}

if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
console.log('Enabled browser automation in', CONFIG_PATH);
console.log('Restart gateway: openclaw gateway --port 18789');
