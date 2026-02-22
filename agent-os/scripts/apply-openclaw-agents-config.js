/**
 * Apply agents.list (Bala, COO, TechResearcher) to OpenClaw config and restart the gateway.
 * Run from agent-os: node scripts/apply-openclaw-agents-config.js
 * Requires: write access to ~/.openclaw/openclaw.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(USERPROFILE, '.openclaw');
const CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');

// Use forward slashes so JSON is valid and OpenClaw accepts them on Windows
const toSlash = (p) => p.replace(/\\/g, '/');
const AGENTS_LIST = [
  { id: 'bala', name: 'Bala', default: true, workspace: toSlash(join(OPENCLAW_DIR, 'workspace')) },
  { id: 'balserve', name: 'COO', workspace: toSlash(join(OPENCLAW_DIR, 'workspace-balserve')) },
  { id: 'techresearcher', name: 'TechResearcher', workspace: toSlash(join(OPENCLAW_DIR, 'workspace-techresearcher')) },
  { id: 'expensemanager', name: 'ExpenseManager', workspace: toSlash(join(OPENCLAW_DIR, 'workspace-expenses')) },
];

const GATEWAY_DEFAULTS = {
  mode: 'local',
  port: 18789,
  http: { endpoints: { chatCompletions: { enabled: true } } },
};

function mergeDeep(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] != null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (target[key] == null) target[key] = {};
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

let config = {};
if (existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not parse existing openclaw.json:', e.message);
    process.exit(1);
  }
}

// Primary model for OpenClaw agents. Override with OPENCLAW_MODEL_PRIMARY (e.g. openai/gpt-4o-mini).
const DEFAULT_MODEL = process.env.OPENCLAW_MODEL_PRIMARY || 'openai/gpt-4o-mini';
// Local Ollama as secondary fallback when primary fails. Override with OPENCLAW_OLLAMA_FALLBACK_MODEL (e.g. llama3.3).
const OLLAMA_FALLBACK = process.env.OPENCLAW_OLLAMA_FALLBACK_MODEL || 'llama3.2';
const OLLAMA_FALLBACK_ID = `ollama/${OLLAMA_FALLBACK}`;

if (!config.agents) config.agents = {};
config.agents.list = AGENTS_LIST;
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.model) config.agents.defaults.model = {};
config.agents.defaults.model.primary = DEFAULT_MODEL;
config.agents.defaults.model.fallbacks = [OLLAMA_FALLBACK_ID];

// Ollama on localhost: optional explicit provider so fallback works without relying only on auto-discovery.
// Set OLLAMA_API_KEY=ollama-local (or any value) so OpenClaw can use Ollama; baseUrl defaults to localhost:11434.
if (!config.models) config.models = {};
if (!config.models.providers) config.models.providers = {};
if (!config.models.providers.ollama) {
  const ollamaBase = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/?$/, '');
  config.models.providers.ollama = {
    baseUrl: ollamaBase + '/v1',
    apiKey: process.env.OLLAMA_API_KEY || 'ollama-local',
    api: 'openai-responses',
  };
}

// Agent-to-agent: explicit allow list (gateway may not accept "*"). All listed agents can use sessions_send.
if (!config.tools) config.tools = {};
config.tools.agentToAgent = {
  enabled: true,
  allow: ['bala', 'balserve', 'techresearcher', 'expensemanager'],
};

// Remove agents.defaults.subagents if present (can prevent gateway from starting).
if (config.agents?.defaults?.subagents) delete config.agents.defaults.subagents;

// Bindings: optional. Route inbound channel messages (WhatsApp/Telegram/Discord) to agents.
// Agent OS HTTP chat uses x-openclaw-agent-id; bindings are for channel routing when enabled.

if (!config.gateway) config.gateway = {};
mergeDeep(config.gateway, GATEWAY_DEFAULTS);

if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
console.log('Written agents.list + model.primary:', DEFAULT_MODEL, '+ fallbacks:', OLLAMA_FALLBACK_ID, '+ tools.agentToAgent to', CONFIG_PATH);
console.log('Restart the OpenClaw gateway so the dashboard picks up the agents:');
console.log('  openclaw gateway restart');
console.log('Or stop the gateway (Ctrl+C) and run: openclaw gateway --port 18789');
