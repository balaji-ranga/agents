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

// Same tools config for all agents that should be able to invoke Agent OS tools.
// IMPORTANT: keep this list to actual TOOL NAMES only. Non-tool entries can cause OpenClaw
// to ignore the allowlist and the agent will not see the tools.
const CONTENT_TOOLS_ALLOW = [
  'summarize_url',
  'generate_image',
  'generate_video',
  'kanban_move_status',
  'kanban_reassign_to_coo',
  'kanban_assign_task',
  'intent_classify_and_delegate',
];
const CONTENT_TOOLS_CONFIG = { allow: [...CONTENT_TOOLS_ALLOW], deny: ['image'] };

// Remove stale/unknown tool names that cause OpenClaw to ignore tools.allow completely.
const REMOVE_FROM_ALLOWLIST = new Set(['cron.add', 'cron_add']);

const AGENTS_LIST = [
  { id: 'bala', name: 'Bala', default: true, workspace: toSlash(join(OPENCLAW_DIR, 'workspace')) },
  { id: 'balserve', name: 'COO', workspace: toSlash(join(OPENCLAW_DIR, 'workspace-balserve')) },
  { id: 'techresearcher', name: 'TechResearcher', workspace: toSlash(join(OPENCLAW_DIR, 'workspace-techresearcher')), tools: { ...CONTENT_TOOLS_CONFIG } },
  { id: 'expensemanager', name: 'ExpenseManager', workspace: toSlash(join(OPENCLAW_DIR, 'workspace-expenses')), tools: { ...CONTENT_TOOLS_CONFIG } },
  { id: 'socialasstant', name: 'SocialAssistant', workspace: toSlash(join(OPENCLAW_DIR, 'workspace-socialasstant')), tools: { ...CONTENT_TOOLS_CONFIG } },
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
// Merge AGENTS_LIST into existing list by id so we set tools for techresearcher/expensemanager/socialasstant like SocialAssistant, and don't drop other agents
const existingList = Array.isArray(config.agents.list) ? config.agents.list : [];
const byId = new Map(existingList.map((a) => [(a.id || '').toLowerCase(), a]));
for (const agent of AGENTS_LIST) {
  const id = (agent.id || '').toLowerCase();
  const existing = byId.get(id);
  if (existing) {
    Object.assign(existing, agent);
    byId.set(id, existing);
  } else {
    byId.set(id, { ...agent });
  }
}
config.agents.list = Array.from(byId.values());

// Ensure per-agent tool allowlists don't contain stale entries.
for (const a of config.agents.list) {
  if (a?.tools?.allow && Array.isArray(a.tools.allow)) {
    a.tools.allow = a.tools.allow.filter((t) => !REMOVE_FROM_ALLOWLIST.has(String(t)));
  }
}
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.model) config.agents.defaults.model = {};
config.agents.defaults.model.primary = DEFAULT_MODEL;
config.agents.defaults.model.fallbacks = [OLLAMA_FALLBACK_ID];

// Ollama on localhost: optional explicit provider so fallback works without relying only on auto-discovery.
// Set OLLAMA_API_KEY=ollama-local (or any value) so OpenClaw can use Ollama; baseUrl defaults to localhost:11434.
if (!config.models) config.models = {};
if (!config.models.providers) config.models.providers = {};
// OpenClaw requires models.providers.ollama.models to be an array of model objects (not strings).
function ollamaModelObject(id) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 81920,
  };
}
if (!config.models.providers.ollama) {
  const ollamaBase = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/?$/, '');
  config.models.providers.ollama = {
    baseUrl: ollamaBase + '/v1',
    apiKey: process.env.OLLAMA_API_KEY || 'ollama-local',
    api: 'openai-responses',
    models: [ollamaModelObject(OLLAMA_FALLBACK)],
  };
} else if (!Array.isArray(config.models.providers.ollama.models) || (config.models.providers.ollama.models[0] && typeof config.models.providers.ollama.models[0] === 'string')) {
  config.models.providers.ollama.models = [ollamaModelObject(OLLAMA_FALLBACK)];
}

// Agent-to-agent: explicit allow list (gateway may not accept "*"). All listed agents can use sessions_send.
if (!config.tools) config.tools = {};
config.tools.agentToAgent = {
  enabled: true,
  allow: ['bala', 'balserve', 'techresearcher', 'expensemanager', 'socialasstant'],
};

// Remove agents.defaults.subagents if present (can prevent gateway from starting).
if (config.agents?.defaults?.subagents) delete config.agents.defaults.subagents;

// Skills: enable agent-send and agent-os-content-tools so they appear in the dashboard and are loaded.
if (!config.skills) config.skills = {};
if (!config.skills.entries) config.skills.entries = {};
config.skills.entries['agent-send'] = { enabled: true, ...config.skills.entries['agent-send'] };
config.skills.entries['agent-os-content-tools'] = { enabled: true, ...config.skills.entries['agent-os-content-tools'] };
config.skills.entries['browser-automation'] = { enabled: true, ...config.skills.entries['browser-automation'] };

// Plugins: load agent-os-content-tools extension so summarize_url, generate_image, generate_video appear as tools.
// Install first: node scripts/install-agent-os-content-tools-extension.js
// Set baseUrl in config or AGENT_OS_API_URL env (e.g. http://127.0.0.1:3001).
const extensionsDir = toSlash(join(OPENCLAW_DIR, 'extensions', 'agent-os-content-tools'));
if (!config.plugins) config.plugins = {};
if (!config.plugins.load) config.plugins.load = {};
if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
if (!config.plugins.load.paths.includes(extensionsDir)) config.plugins.load.paths.push(extensionsDir);
if (!config.plugins.entries) config.plugins.entries = {};
const existingPlugin = config.plugins.entries['agent-os-content-tools'];
config.plugins.entries['agent-os-content-tools'] = {
  ...existingPlugin,
  enabled: true,
  config: existingPlugin?.config || {},
};
if (!config.plugins.allow) config.plugins.allow = [];
if (!config.plugins.allow.includes('agent-os-content-tools')) config.plugins.allow.push('agent-os-content-tools');

// Browser automation (Playwright-managed openclaw profile). Install: .\scripts\install-openclaw-playwright.ps1
// Root browser block activates bundled browser tool; do not add "browser" to plugins.allow.
if (!config.browser) config.browser = {};
config.browser.enabled = true;
config.browser.defaultProfile = config.browser.defaultProfile || 'openclaw';
if (!config.browser.profiles) {
  config.browser.profiles = { openclaw: { cdpPort: 18800, color: '#FF4500' } };
}

// Tools: allow content tools, kanban tools, intent-classify-and-delegate.
// Note: OpenClaw will ignore the entire tools.allow if it contains unknown tool names.
// The Gateway cron tools (cron.add / cron_add) are not present in newer OpenClaw builds,
// so we do NOT include them here.
const contentToolNames = [
  'summarize_url',
  'generate_image',
  'generate_video',
  'kanban_move_status',
  'kanban_reassign_to_coo',
  'kanban_assign_task',
  'intent_classify_and_delegate',
  'browser',
];
if (!Array.isArray(config.tools.allow)) config.tools.allow = [];
config.tools.allow = config.tools.allow.filter((t) => !REMOVE_FROM_ALLOWLIST.has(String(t)));
for (const name of contentToolNames) {
  if (!config.tools.allow.includes(name)) config.tools.allow.push(name);
}

// Per-agent tool overrides: ~/.openclaw/agent-os-tool-overrides.json maps tool_name -> ["agent1","agent2"] or "All"
const OVERRIDES_PATH = join(OPENCLAW_DIR, 'agent-os-tool-overrides.json');
let toolOverrides = {};
if (existsSync(OVERRIDES_PATH)) {
  try {
    toolOverrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch (_) {}
}
for (const a of config.agents.list) {
  const aid = (a.id || '').toLowerCase();
  const allow = Array.isArray(a.tools?.allow) ? [...a.tools.allow] : [...contentToolNames];
  for (const [toolName, agentsSpec] of Object.entries(toolOverrides)) {
    if (agentsSpec === 'All' || (Array.isArray(agentsSpec) && agentsSpec.some((id) => String(id).toLowerCase() === aid))) {
      if (!allow.includes(toolName)) allow.push(toolName);
    }
  }
  a.tools = a.tools || {};
  a.tools.allow = allow;
}

// Bindings: optional. Route inbound channel messages (WhatsApp/Telegram/Discord) to agents.
// Agent OS HTTP chat uses x-openclaw-agent-id; bindings are for channel routing when enabled.

if (!config.gateway) config.gateway = {};
mergeDeep(config.gateway, GATEWAY_DEFAULTS);

if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
console.log('Written agents.list + model.primary:', DEFAULT_MODEL, '+ fallbacks:', OLLAMA_FALLBACK_ID, '+ tools.agentToAgent to', CONFIG_PATH);
console.log('TechResearcher, ExpenseManager, SocialAssistant: same tools.allow (agent-os-content-tools + kanban/intent tools).');
console.log('Restart the OpenClaw gateway so the dashboard picks up the agents:');
console.log('  openclaw gateway restart');
console.log('Or stop the gateway (Ctrl+C) and run: openclaw gateway --port 18789');
