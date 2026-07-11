/**
 * Ensure TOOLS_API_KEY exists and stays in sync between backend env and openclaw.json.
 *
 * Local dev:
 *   node scripts/ensure-tools-api-key.js
 *   → backend/.env + ~/.openclaw/openclaw.json
 *
 * Docker deploy (before init):
 *   node scripts/ensure-tools-api-key.js --env-file deploy/.env --skip-openclaw
 *   → deploy/.env only; init runs configure-openclaw-docker.js to write openclaw.json
 */
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveOpenClawConfigPath } from './lib/openclaw-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');

function parseArgs(argv) {
  let envFile = join(AGENT_OS_ROOT, 'backend', '.env');
  let skipOpenClaw = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--env-file' && argv[i + 1]) {
      envFile = argv[++i];
      continue;
    }
    if (arg === '--skip-openclaw') {
      skipOpenClaw = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      console.log(`Usage: node scripts/ensure-tools-api-key.js [--env-file PATH] [--skip-openclaw]

Ensures TOOLS_API_KEY is set in the env file and (unless --skip-openclaw) in openclaw.json
plugins.entries['agent-os-content-tools'].config.apiKey.

Default env file: backend/.env
OpenClaw config: OPENCLAW_CONFIG_PATH or ~/.openclaw/openclaw.json`);
      process.exit(0);
    }
    console.error('Unknown argument:', arg);
    process.exit(1);
  }
  return { envFile, skipOpenClaw };
}

function ensureEnvKey(envPath) {
  let key = '';
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const match = content.match(/^TOOLS_API_KEY=(.+)$/m);
  if (match) {
    key = match[1].trim();
    console.log(`${envPath} already has TOOLS_API_KEY`);
  } else {
    key = randomBytes(24).toString('hex');
    const prefix = content.length && !content.endsWith('\n') ? '\n' : '';
    const line = `${prefix}\n# OpenClaw content-tools plugin auth (auto-generated)\nTOOLS_API_KEY=${key}\n`;
    writeFileSync(envPath, content + line, 'utf8');
    console.log(`Added TOOLS_API_KEY to ${envPath}`);
  }
  return key;
}

function ensureOpenClawConfig(key, internalApiUrl) {
  const configPath = resolveOpenClawConfigPath();
  if (!existsSync(configPath)) {
    console.warn('openclaw.json not found at', configPath);
    return;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  const entry = config.plugins.entries['agent-os-content-tools'] || { enabled: true, config: {} };
  entry.enabled = entry.enabled !== false;
  entry.config = { ...(entry.config || {}), apiKey: key };
  if (!entry.config.baseUrl) {
    entry.config.baseUrl =
      internalApiUrl ||
      process.env.AGENT_OS_INTERNAL_API_URL ||
      process.env.AGENT_OS_API_URL ||
      'http://127.0.0.1:3001';
  }
  config.plugins.entries['agent-os-content-tools'] = entry;
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log('Updated openclaw.json agent-os-content-tools.config.apiKey');
}

const { envFile, skipOpenClaw } = parseArgs(process.argv.slice(2));
const key = ensureEnvKey(envFile);
if (!skipOpenClaw) {
  ensureOpenClawConfig(key);
}
console.log('Restart backend and OpenClaw gateway for changes to take effect.');
