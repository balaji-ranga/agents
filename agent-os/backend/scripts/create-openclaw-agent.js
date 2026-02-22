/**
 * Create a new OpenClaw agent from a definition JSON file.
 * Run from backend: node scripts/create-openclaw-agent.js path/to/agent-def.json
 *
 * Definition JSON shape:
 * {
 *   "id": "contentwriter",
 *   "name": "Content Writer",
 *   "role": "Content & copy",
 *   "parent_id": "balserve",
 *   "soul_md": "# SOUL — ...",
 *   "agents_md": "# AGENTS — ...",
 *   "memory_md": "# MEMORY — ..."
 * }
 *
 * Creates: workspace dir, SOUL.md/AGENTS.md/MEMORY.md, openclaw.json entry, agent dirs, DB row.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../src/db/schema.js';
import * as workspace from '../src/workspace/adapter.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const homedir = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(homedir, '.openclaw');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(OPENCLAW_DIR, 'openclaw.json');

const toSlash = (p) => p.replace(/\\/g, '/');

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

const defPath = process.argv[2];
if (!defPath) {
  console.error('Usage: node scripts/create-openclaw-agent.js <path-to-agent-def.json>');
  process.exit(1);
}

let def;
try {
  def = JSON.parse(readFileSync(defPath, 'utf8'));
} catch (e) {
  console.error('Failed to read definition file:', e.message);
  process.exit(1);
}

const id = (def.id || '').trim().toLowerCase();
const name = (def.name || id).trim();
const role = (def.role || '').trim();
const parentId = (def.parent_id || 'balserve').trim().toLowerCase() || null;

if (!id) {
  console.error('Definition must have "id"');
  process.exit(1);
}

const workspaceDirName = `workspace-${id}`;
const WORKSPACE_PATH = process.env[`OPENCLAW_WORKSPACE_${id.toUpperCase().replace(/-/g, '_')}`] || join(OPENCLAW_DIR, workspaceDirName);

if (!existsSync(WORKSPACE_PATH)) mkdirSync(WORKSPACE_PATH, { recursive: true });
const memoryDir = join(WORKSPACE_PATH, 'memory');
if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

const soulMd = def.soul_md || `# SOUL — ${name}\n\nYou are **${name}**. ${role || 'Specialist agent.'}\n\n## Voice and temperament\n- Professional and clear.\n\n## Values\n- Quality and accuracy.\n\n## Boundaries\n- Stay in role; escalate when needed.\n`;
const agentsMd = def.agents_md || `# AGENTS — Operating contract (${name})\n\n## Role\n${role || 'Specialist.'}\n\n## Priorities\n1. Fulfill requests in your domain.\n2. Report to COO when relevant.\n\n## Boundaries\n- Do not change other agents' SOUL or AGENTS. Escalate approvals to COO/CEO.\n`;
const memoryMd = def.memory_md || `# MEMORY — ${name}\n\n## Facts\n- Role: ${role || 'Specialist'}.\n- Reports to: COO (BalServe).\n`;

await workspace.writeWorkspaceFile('soul', soulMd, { workspaceRoot: WORKSPACE_PATH });
await workspace.writeWorkspaceFile('agents', agentsMd, { workspaceRoot: WORKSPACE_PATH });
await workspace.writeWorkspaceFile('memory', memoryMd, { workspaceRoot: WORKSPACE_PATH });
console.log('Wrote SOUL.md, AGENTS.md, MEMORY.md to', WORKSPACE_PATH);

let config = {};
if (existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not parse openclaw.json:', e.message);
    process.exit(1);
  }
}
if (!config.agents) config.agents = {};
if (!config.agents.list) config.agents.list = [];
const existingInList = config.agents.list.find((a) => (a.id || '').toLowerCase() === id);
if (!existingInList) {
  config.agents.list.push({
    id,
    name,
    workspace: toSlash(WORKSPACE_PATH),
  });
  console.log('Added to openclaw.json agents.list');
} else {
  existingInList.name = name;
  existingInList.workspace = toSlash(WORKSPACE_PATH);
  console.log('Updated existing entry in openclaw.json agents.list');
}

if (!config.tools) config.tools = {};
if (!config.tools.agentToAgent) config.tools.agentToAgent = { enabled: true, allow: [] };
if (!Array.isArray(config.tools.agentToAgent.allow)) config.tools.agentToAgent.allow = [];
if (!config.tools.agentToAgent.allow.includes(id)) {
  config.tools.agentToAgent.allow.push(id);
  console.log('Added to tools.agentToAgent.allow');
}

if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
console.log('Saved', CONFIG_PATH);

const AGENTS_ROOT = join(OPENCLAW_DIR, 'agents');
for (const dir of [join(AGENTS_ROOT, id, 'agent'), join(AGENTS_ROOT, id, 'sessions')]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    if (dir.endsWith('agent')) writeFileSync(join(dir, 'auth.json'), '{}', 'utf8');
    if (dir.endsWith('sessions')) writeFileSync(join(dir, 'sessions.json'), '{}', 'utf8');
    console.log('Created', dir);
  }
}

const db = getDb();
const existingRow = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
if (existingRow) {
  db.prepare(
    'UPDATE agents SET name = ?, role = ?, parent_id = ?, workspace_path = ?, openclaw_agent_id = ? WHERE id = ?'
  ).run(name, role, parentId, WORKSPACE_PATH, id, id);
  console.log('Updated agent-os DB row for', id);
} else {
  db.prepare(
    `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, role, parentId, WORKSPACE_PATH, id, 0);
  console.log('Inserted agent-os DB row for', id);
}

console.log('Done. Restart the OpenClaw gateway to use the new agent: openclaw gateway --port 18789');
process.exit(0);
