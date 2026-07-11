/**
 * Verify Docker/bare-metal OpenClaw bootstrap matches Agent OS expectations.
 * Run: node deploy/scripts/verify-openclaw-parity.js
 * Exit 0 = all checks passed; 1 = missing items (prints list).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveOpenClawDir, resolveOpenClawConfigPath } from '../../scripts/lib/openclaw-paths.js';

const OPENCLAW_DIR = resolveOpenClawDir();
const CONFIG_PATH = resolveOpenClawConfigPath();

const REQUIRED_AGENTS = [
  'bala',
  'balserve',
  'workflowbuilder',
  'techresearcher',
  'expensemanager',
  'socialasstant',
];

const OPTIONAL_JOB_AGENTS = ['jobdiscovery', 'fitscorer', 'resumetailor', 'applicationagent'];

const REQUIRED_GLOBAL_TOOLS = [
  'summarize_url',
  'generate_image',
  'generate_video',
  'browser',
  'agent_workflow_list',
  'agent_workflow_trigger',
  'intent_classify_and_delegate',
];

const REQUIRED_SKILLS = ['agent-send', 'agent-os-content-tools', 'browser-automation'];

const REQUIRED_PLUGINS = ['agent-os-content-tools', 'agent-os-bootstrap-watcher'];

const REQUIRED_EXTENSIONS = ['agent-os-content-tools', 'agent-os-bootstrap-watcher'];

const failures = [];
const warnings = [];

function fail(msg) {
  failures.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

if (!existsSync(CONFIG_PATH)) {
  console.error('Missing', CONFIG_PATH);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('Invalid openclaw.json:', e.message);
  process.exit(1);
}

// Gateway
if (!config.gateway?.http?.endpoints?.chatCompletions?.enabled) {
  fail('gateway.http.endpoints.chatCompletions.enabled is not true');
}
if (!config.gateway?.auth?.token) {
  warn('gateway.auth.token not set (pairing may be required)');
}

// Browser
if (!config.browser?.enabled) {
  fail('browser.enabled is not true');
}

// Session visibility (Agent OS delegation)
const vis = config.tools?.sessions?.visibility;
if (vis && vis !== 'agent' && vis !== 'all') {
  warn(`tools.sessions.visibility is "${vis}" (expected agent or all)`);
}

// Skills on disk + config
for (const skill of REQUIRED_SKILLS) {
  const skillDir = join(OPENCLAW_DIR, 'skills', skill);
  if (!existsSync(skillDir)) fail(`missing skill directory: ${skillDir}`);
  if (!config.skills?.entries?.[skill]?.enabled) fail(`skill not enabled in config: ${skill}`);
}

// Extensions on disk + plugins
for (const ext of REQUIRED_EXTENSIONS) {
  const extDir = join(OPENCLAW_DIR, 'extensions', ext);
  if (!existsSync(extDir)) fail(`missing extension directory: ${extDir}`);
}
for (const plugin of REQUIRED_PLUGINS) {
  if (!config.plugins?.entries?.[plugin]?.enabled) fail(`plugin not enabled: ${plugin}`);
  if (!config.plugins?.allow?.includes(plugin)) warn(`plugin not in plugins.allow: ${plugin}`);
}

const contentTools = config.plugins?.entries?.['agent-os-content-tools'];
const baseUrl = contentTools?.config?.baseUrl || process.env.AGENT_OS_INTERNAL_API_URL;
const apiKey = contentTools?.config?.apiKey || process.env.TOOLS_API_KEY;
if (!baseUrl) {
  warn('agent-os-content-tools config.baseUrl not set (uses AGENT_OS_API_URL env at runtime)');
} else if (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost')) {
  warn(`agent-os-content-tools baseUrl is local (${baseUrl}) — use http://backend:3001 in Docker`);
}
if (!apiKey) {
  fail('agent-os-content-tools config.apiKey / TOOLS_API_KEY not set — run ensure-tools-api-key.js or configure-openclaw-docker.js');
} else if (process.env.TOOLS_API_KEY && apiKey !== process.env.TOOLS_API_KEY) {
  fail('agent-os-content-tools config.apiKey does not match TOOLS_API_KEY env — re-run configure-openclaw-docker.js or ensure-tools-api-key.js');
}

// Global tools.allow
const globalAllow = config.tools?.allow || [];
for (const t of REQUIRED_GLOBAL_TOOLS) {
  if (!globalAllow.includes(t)) fail(`tools.allow missing: ${t}`);
}

// Agents
const agentIds = (config.agents?.list || []).map((a) => String(a.id || '').toLowerCase());
for (const id of REQUIRED_AGENTS) {
  if (!agentIds.includes(id)) fail(`agents.list missing: ${id}`);
}
const jobPresent = OPTIONAL_JOB_AGENTS.filter((id) => agentIds.includes(id));
if (jobPresent.length === 0) {
  warn('Job Applicant agents not in openclaw.json (run setup-job-applicant-agents.js if needed)');
} else if (jobPresent.length < OPTIONAL_JOB_AGENTS.length) {
  warn(`Partial Job Applicant agents: ${jobPresent.join(', ')}`);
}

// Agent-to-agent
if (!config.tools?.agentToAgent?.enabled) {
  warn('tools.agentToAgent.enabled is not true');
}

// Tools list file (backend sync)
const toolsListPath = join(OPENCLAW_DIR, 'agent-os-tools.json');
if (!existsSync(toolsListPath)) {
  warn('agent-os-tools.json missing (backend writeOpenClawToolsList runs on startup)');
}

console.log('OpenClaw dir:', OPENCLAW_DIR);
console.log('Config:', CONFIG_PATH);
console.log('Agents:', agentIds.length, '→', agentIds.join(', '));

if (warnings.length) {
  console.log('\nWarnings:');
  warnings.forEach((w) => console.log('  ⚠', w));
}

if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  ✗', f));
  process.exit(1);
}

console.log('\nAll required OpenClaw parity checks passed.');
if (jobPresent.length === OPTIONAL_JOB_AGENTS.length) {
  console.log('Job Applicant agents present.');
}
