/**
 * Per-agent content tool grants — DB source of truth, hot-sync to OpenClaw without gateway restart.
 * - agent_tool_grants table
 * - ~/.openclaw/agent-tool-allowlists.json (plugin reads on each tool factory call)
 * - openclaw.json agents.list[].tools.allow (persistence / fallback)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/schema.js';
import * as meta from './content-tools-meta.js';
import * as workspace from '../workspace/adapter.js';
import { getOpenClawDir, getOpenClawConfigPath } from '../config/openclaw-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_TEMPLATES = join(__dirname, '..', '..', 'openclaw-workspace-templates');

const OPENCLAW_DIR = getOpenClawDir();
const CONFIG_PATH = getOpenClawConfigPath();
const ALLOWLISTS_PATH = join(OPENCLAW_DIR, 'agent-tool-allowlists.json');
const home = process.env.USERPROFILE || process.env.HOME || '';

const NATIVE_OPENCLAW_TOOLS = new Set(['browser', 'image', 'cron', 'cron_add']);

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return { agents: { list: [] }, tools: { allow: [] } };
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config) {
  if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function resolveOpenClawAgentId(agent) {
  return String(agent?.openclaw_agent_id || agent?.id || '').trim().toLowerCase();
}

function contentToolNamesSet() {
  return new Set(meta.listToolsMeta().map((t) => t.name));
}

export function getAgentToolGrants(agentId) {
  const db = getDb();
  return db
    .prepare('SELECT tool_name FROM agent_tool_grants WHERE agent_id = ? ORDER BY tool_name')
    .all(agentId)
    .map((r) => r.tool_name);
}

function openClawAllowForAgent(ocId) {
  const config = readConfig();
  const entry = (config.agents?.list || []).find((a) => String(a.id || '').toLowerCase() === String(ocId).toLowerCase());
  return Array.isArray(entry?.tools?.allow) ? entry.tools.allow : null;
}

export function isToolGrantedToAgent(agentOpenClawId, toolName) {
  if (!agentOpenClawId || !toolName) return false;
  if (NATIVE_OPENCLAW_TOOLS.has(toolName)) return true;
  const allowlists = readAllowlistsFile();
  const key = String(agentOpenClawId).toLowerCase();
  const list = allowlists[key];
  if (Array.isArray(list)) return list.includes(toolName);
  const fromConfig = openClawAllowForAgent(key);
  if (Array.isArray(fromConfig)) return fromConfig.includes(toolName);
  return false;
}

/** Enforce per-agent grants on /api/tools/invoke (skip when caller is unknown). */
export function assertCallerMayUseTool(source, toolName) {
  if (!source || !toolName) return { ok: true };
  const db = getDb();
  const caller = db
    .prepare('SELECT * FROM agents WHERE LOWER(id) = LOWER(?) OR LOWER(openclaw_agent_id) = LOWER(?)')
    .get(source, source);
  if (!caller) return { ok: true };
  const ocId = resolveOpenClawAgentId(caller);
  if (isToolGrantedToAgent(ocId, toolName)) return { ok: true };
  return { ok: false, error: `Tool "${toolName}" is not granted to agent "${ocId}"` };
}

export function readAllowlistsFile() {
  if (!existsSync(ALLOWLISTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ALLOWLISTS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Write hot-reload file consumed by the OpenClaw plugin (no gateway restart). */
export function syncAllowlistsFile() {
  const db = getDb();
  const agents = db.prepare('SELECT id, openclaw_agent_id FROM agents').all();
  const out = {};
  for (const a of agents) {
    const grants = getAgentToolGrants(a.id);
    if (!grants.length) continue;
    const ocId = resolveOpenClawAgentId(a);
    if (ocId) out[ocId] = grants;
  }
  if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(ALLOWLISTS_PATH, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

function mergeNativeTools(existingAllow = [], contentGrants = []) {
  const contentSet = contentToolNamesSet();
  const native = (existingAllow || []).filter((t) => NATIVE_OPENCLAW_TOOLS.has(t) || !contentSet.has(t));
  const merged = [...new Set([...native, ...contentGrants])];
  return merged.filter((t) => t !== 'image');
}

export function syncOpenClawJsonForAgent(agent) {
  const ocId = resolveOpenClawAgentId(agent);
  if (!ocId) return null;
  const grants = getAgentToolGrants(agent.id);
  const config = readConfig();
  if (!Array.isArray(config.agents?.list)) config.agents = { list: [] };
  let entry = config.agents.list.find((a) => String(a.id || '').toLowerCase() === ocId);
  if (!entry) {
    entry = {
      id: ocId,
      name: agent.name || ocId,
      workspace: agent.workspace_path || join(OPENCLAW_DIR, `workspace-${ocId}`).replace(/\\/g, '/'),
    };
    config.agents.list.push(entry);
  }
  const prevAllow = Array.isArray(entry.tools?.allow) ? entry.tools.allow : [];
  entry.tools = entry.tools || {};
  entry.tools.allow = mergeNativeTools(prevAllow, grants);
  if (!entry.tools.deny) entry.tools.deny = ['image'];
  writeConfig(config);
  return entry.tools.allow;
}

/** Import grants from openclaw.json when DB has none for an agent. */
export function importGrantsFromOpenClawConfig() {
  const config = readConfig();
  const db = getDb();
  const agents = db.prepare('SELECT * FROM agents').all();
  const contentSet = contentToolNamesSet();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO agent_tool_grants (agent_id, tool_name) VALUES (?, ?)'
  );
  let imported = 0;
  for (const agent of agents) {
    const existing = getAgentToolGrants(agent.id);
    if (existing.length) continue;
    const ocId = resolveOpenClawAgentId(agent);
    const entry = (config.agents?.list || []).find((a) => String(a.id || '').toLowerCase() === ocId);
    const allow = entry?.tools?.allow || [];
    for (const t of allow) {
      if (contentSet.has(t)) {
        ins.run(agent.id, t);
        imported++;
      }
    }
  }
  if (imported) syncAllowlistsFile();
  return imported;
}

export function listToolsCatalogForAgent(agentId) {
  const granted = new Set(getAgentToolGrants(agentId));
  return meta
    .listToolsMeta()
    .filter((t) => t.enabled)
    .map((t) => ({
      name: t.name,
      display_name: t.display_name,
      purpose: t.purpose,
      is_builtin: !!t.is_builtin,
      granted: granted.has(t.name),
    }));
}

export function setAgentToolGrants(agent, toolNames) {
  const db = getDb();
  const contentSet = contentToolNamesSet();
  const normalized = [...new Set((toolNames || []).map((t) => String(t).trim()).filter((t) => contentSet.has(t)))];
  db.prepare('DELETE FROM agent_tool_grants WHERE agent_id = ?').run(agent.id);
  const ins = db.prepare('INSERT INTO agent_tool_grants (agent_id, tool_name) VALUES (?, ?)');
  for (const t of normalized) ins.run(agent.id, t);
  syncAllowlistsFile();
  const allow = syncOpenClawJsonForAgent(agent);
  return { grants: normalized, openclaw_allow: allow };
}

/** Build TOOLS.md body from granted tools + optional template extras. */
export function buildToolsMdContent(grantedToolNames) {
  const lines = [
    '# TOOLS — Agent OS tools',
    '',
    'When you have access to Agent OS tools, invoke them **by tool name with JSON parameters**; do not use exec or run as shell commands.',
    '',
    '---',
    '',
    '## Granted tools',
    '',
  ];
  const metaByName = Object.fromEntries(meta.listToolsMeta().map((t) => [t.name, t]));
  for (const name of grantedToolNames.sort()) {
    const t = metaByName[name];
    if (!t) continue;
    const label = t.display_name || name;
    const purpose = (t.purpose || '').split('.')[0];
    lines.push(`- **${name}** — ${label}${purpose ? `: ${purpose}` : ''}`);
  }
  lines.push(
    '',
    '---',
    '',
    '## Choosing the right tool',
    '',
    '- **Match the tool to the request:** Read the user\'s message and choose the tool whose purpose best fits.',
    '- **If a tool\'s result is not good enough:** Try the next most relevant granted tool before giving up.',
    '',
    '---',
    '',
    '## Browser automation (OpenClaw + Playwright)',
    '',
    'You have the **browser** tool when enabled in OpenClaw config.',
    '',
    '- **Always use `profile="openclaw"`** for managed Playwright/Chromium.',
    ''
  );
  return lines.join('\n');
}

export async function writeAgentToolsMd(agent, grantedToolNames) {
  const root = agent.workspace_path
    ? agent.workspace_path.startsWith('~')
      ? join(home, agent.workspace_path.slice(1).replace(/^[/\\]/, ''))
      : agent.workspace_path
    : null;
  if (!root) return null;
  const text = buildToolsMdContent(grantedToolNames);
  await workspace.writeWorkspaceFile('tools', text, { workspaceRoot: root });
  return text;
}

export async function syncToolsMdFromTemplate(agent, templateId = null) {
  const tid = templateId || agent.id;
  let templatePath = join(REPO_TEMPLATES, tid, 'TOOLS.md');
  if (!existsSync(templatePath)) templatePath = join(REPO_TEMPLATES, 'balserve', 'TOOLS.md');
  if (!existsSync(templatePath)) throw new Error(`No TOOLS.md template for ${tid}`);
  const text = readFileSync(templatePath, 'utf8');
  const root = agent.workspace_path
    ? agent.workspace_path.startsWith('~')
      ? join(home, agent.workspace_path.slice(1).replace(/^[/\\]/, ''))
      : agent.workspace_path
    : join(OPENCLAW_DIR, `workspace-${resolveOpenClawAgentId(agent)}`);
  await workspace.writeWorkspaceFile('tools', text, { workspaceRoot: root });
  return text;
}
