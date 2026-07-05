/**
 * Onboard a new API as an OpenClaw tool for select agents or all agents.
 *
 * Usage:
 *   node scripts/onboard-api-tool.js <path-to-definition.json>
 *
 * JSON definition:
 *   {
 *     "name": "tool_name",
 *     "description": "Human-readable purpose (shown to agent)",
 *     "endpoint": "https://api.example.com/v1/action or /api/tools/local-route",
 *     "method": "GET or POST (default POST)",
 *     "api_key_bearer": "optional Bearer token or raw key (will be sent as Bearer ...)",
 *     "applicable_agents": ["expensemanager", "techresearcher"] or "All"
 *   }
 *
 * - Registers the tool in content_tools_meta (DB) and writes ~/.openclaw/agent-os-tools.json.
 * - Updates ~/.openclaw/agent-os-tool-overrides.json and merges into openclaw.json so only
 *   the specified agents get this tool.
 * - Restart the OpenClaw gateway after onboarding.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKEND = join(ROOT, 'backend');

// Backend .env is not loaded here; schema uses AGENT_OS_DATA_DIR or default backend/data

const { getDb, initDb } = await import(new URL('../backend/src/db/schema.js', import.meta.url).href);
const meta = await import(new URL('../backend/src/services/content-tools-meta.js', import.meta.url).href);

const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(USERPROFILE, '.openclaw');
const CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');
const OVERRIDES_PATH = join(OPENCLAW_DIR, 'agent-os-tool-overrides.json');

function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error('Usage: node scripts/onboard-api-tool.js <path-to-definition.json>');
    process.exit(1);
  }
  let def;
  try {
    def = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.error('Failed to read or parse JSON:', e.message);
    process.exit(1);
  }
  const name = (def.name || '').trim();
  const description = (def.description || def.purpose || '').trim();
  const endpoint = (def.endpoint || '').trim();
  const method = ((def.method || 'POST') + '').toUpperCase();
  const applicableAgents = def.applicable_agents;
  if (!name || !endpoint) {
    console.error('Definition must include name and endpoint.');
    process.exit(1);
  }
  const toolName = name.toLowerCase().replace(/\s+/g, '_');
  let authHeader = '';
  if (def.api_key_bearer && String(def.api_key_bearer).trim()) {
    const raw = String(def.api_key_bearer).trim();
    authHeader = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  }

  initDb();
  const db = getDb();
  const existing = meta.getToolMeta(toolName);
  if (existing) {
    meta.updateToolMeta(toolName, {
      display_name: description || toolName,
      endpoint,
      method,
      purpose: description || `Call external API: ${endpoint}`,
      auth_header: authHeader,
    });
    console.log('Updated existing tool:', toolName);
  } else {
    meta.createToolMeta({
      name: toolName,
      display_name: description || toolName,
      endpoint,
      method,
      purpose: description || `Call external API: ${endpoint}`,
      auth_header: authHeader,
    });
    console.log('Created tool:', toolName);
  }
  meta.writeOpenClawToolsList();

  let overrides = {};
  if (existsSync(OVERRIDES_PATH)) {
    try {
      overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    } catch (_) {}
  }
  const newAgents = applicableAgents === 'All' ? 'All' : (Array.isArray(applicableAgents) ? applicableAgents.map((a) => String(a).toLowerCase()) : []);
  if (newAgents !== 'All' && newAgents.length === 0) {
    console.error('applicable_agents must be "All" or a non-empty array of agent ids.');
    process.exit(1);
  }
  // Merge with existing: if tool already has agents, add new ones (unless new is "All")
  const prevAgents = overrides[toolName];
  if (prevAgents === 'All') {
    overrides[toolName] = 'All';
  } else if (newAgents === 'All') {
    overrides[toolName] = 'All';
  } else {
    const merged = new Set(Array.isArray(prevAgents) ? prevAgents : []);
    newAgents.forEach((a) => merged.add(a));
    overrides[toolName] = Array.from(merged);
  }
  if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2), 'utf8');
  console.log('Wrote tool overrides to', OVERRIDES_PATH);

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error('Could not parse openclaw.json:', e.message);
      process.exit(1);
    }
  }
  const contentToolNames = [
    'summarize_url', 'generate_image', 'generate_video',
    'kanban_move_status', 'kanban_reassign_to_coo', 'kanban_assign_task', 'intent_classify_and_delegate',
  ];
  for (const a of config.agents?.list || []) {
    const aid = (a.id || '').toLowerCase();
    const allow = Array.isArray(a.tools?.allow) ? [...a.tools.allow] : [...contentToolNames];
    const agentsSpec = overrides[toolName];
    if (agentsSpec === 'All' || (Array.isArray(agentsSpec) && agentsSpec.includes(aid))) {
      if (!allow.includes(toolName)) allow.push(toolName);
    }
    a.tools = a.tools || {};
    a.tools.allow = allow;
  }
  if (!Array.isArray(config.tools?.allow)) config.tools = config.tools || {};
  config.tools.allow = config.tools.allow || [];
  if (!config.tools.allow.includes(toolName)) config.tools.allow.push(toolName);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log('Updated', CONFIG_PATH, '— added', toolName, 'to applicable agents.');
  console.log('Restart the OpenClaw gateway: npx openclaw gateway --port 18789');
}

main();
