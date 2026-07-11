/**
 * Merge production/container settings into openclaw.json after apply-openclaw-agents-config.js.
 * - gateway.auth.token from OPENCLAW_GATEWAY_TOKEN
 * - agent-os-content-tools plugin baseUrl from AGENT_OS_INTERNAL_API_URL (default http://backend:3001)
 * - agent-os-content-tools plugin apiKey from TOOLS_API_KEY (must match backend env)
 * - Ollama provider baseUrl from OLLAMA_BASE_URL (default http://ollama:11434 when profile enabled)
 * - tools.sessions.visibility = agent (Agent OS delegation / session history)
 *
 * Run: node deploy/scripts/configure-openclaw-docker.js
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { resolveOpenClawDir } from '../../scripts/lib/openclaw-paths.js';

const OPENCLAW_DIR = resolveOpenClawDir();
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(OPENCLAW_DIR, 'openclaw.json');

const GATEWAY_TOKEN = String(process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
const TOOLS_API_KEY = String(process.env.TOOLS_API_KEY || '').trim();
const INTERNAL_API = String(process.env.AGENT_OS_INTERNAL_API_URL || 'http://backend:3001').replace(/\/$/, '');
const OLLAMA_BASE = String(process.env.OLLAMA_BASE_URL || 'http://ollama:11434').replace(/\/?$/, '');
const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
const SESSION_VISIBILITY = process.env.OPENCLAW_SESSION_VISIBILITY || 'agent';

if (!existsSync(CONFIG_PATH)) {
  console.error('openclaw.json not found at', CONFIG_PATH);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('Could not parse openclaw.json:', e.message);
  process.exit(1);
}

if (!config.gateway) config.gateway = {};
config.gateway.mode = config.gateway.mode || 'local';
config.gateway.port = GATEWAY_PORT;
if (!config.gateway.http) config.gateway.http = {};
if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};
if (!config.gateway.http.endpoints.chatCompletions) {
  config.gateway.http.endpoints.chatCompletions = { enabled: true };
} else {
  config.gateway.http.endpoints.chatCompletions.enabled = true;
}

if (GATEWAY_TOKEN) {
  config.gateway.auth = { ...(config.gateway.auth || {}), token: GATEWAY_TOKEN };
  console.log('Set gateway.auth.token from OPENCLAW_GATEWAY_TOKEN');
} else {
  console.warn('OPENCLAW_GATEWAY_TOKEN not set — gateway may require device pairing (see GATEWAY-PAIRING-1008.md)');
}

if (!config.tools) config.tools = {};
if (!config.tools.sessions) config.tools.sessions = {};
config.tools.sessions.visibility = SESSION_VISIBILITY;
console.log('Set tools.sessions.visibility:', SESSION_VISIBILITY);

if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
const plugin = config.plugins.entries['agent-os-content-tools'] || {};
const pluginConfig = {
  ...(plugin.config || {}),
  baseUrl: INTERNAL_API,
};
if (TOOLS_API_KEY) {
  pluginConfig.apiKey = TOOLS_API_KEY;
  console.log('Set agent-os-content-tools apiKey from TOOLS_API_KEY');
} else {
  console.warn(
    'TOOLS_API_KEY not set — content-tools plugin will fail until deploy/.env has TOOLS_API_KEY and init is re-run'
  );
}
config.plugins.entries['agent-os-content-tools'] = {
  ...plugin,
  enabled: true,
  config: pluginConfig,
};
console.log('Set agent-os-content-tools baseUrl:', INTERNAL_API);

if (config.models?.providers?.ollama) {
  config.models.providers.ollama.baseUrl = `${OLLAMA_BASE}/v1`;
  console.log('Set Ollama baseUrl:', `${OLLAMA_BASE}/v1`);
}

if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
console.log('Updated', CONFIG_PATH);
