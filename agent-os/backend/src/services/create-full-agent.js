/**
 * Create a full OpenClaw agent: workspace, SOUL/AGENTS/MEMORY (with session history + tool fallback),
 * openclaw.json entry, agent dirs, default tools, DB row.
 * Used by the Add Agent UI flow so new agents get the same behavior as TechResearcher/ExpenseManager.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/schema.js';
import * as workspace from '../workspace/adapter.js';

const homedir = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(homedir, '.openclaw');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(OPENCLAW_DIR, 'openclaw.json');

const toSlash = (p) => p.replace(/\\/g, '/');

/** Default tools for new agents (same as apply-openclaw-agents-config). */
const DEFAULT_TOOLS_ALLOW = [
  'summarize_url',
  'generate_image',
  'generate_video',
  'kanban_move_status',
  'kanban_reassign_to_coo',
  'kanban_assign_task',
  'intent_classify_and_delegate',
  'browser',
];

/**
 * Append a new agent row to a manager's AGENTS.md table (so COO/parent can delegate).
 * Finds the last markdown table row (line starting with | and containing **) and inserts after it.
 */
async function appendAgentRowToAgentsMd(workspaceRoot, agent, relationText = 'reports to you') {
  let content = '';
  try {
    const result = await workspace.readWorkspaceFile('agents', { workspaceRoot });
    content = result?.text ?? '';
  } catch (_) {
    return;
  }
  const lines = content.split(/\r?\n/);
  const tableRowRe = /^\|\s*\*\*[^*]+\*\*\s*\|/;
  let lastTableRowIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (tableRowRe.test(lines[i])) lastTableRowIndex = i;
  }
  const roleCell = `${(agent.role || 'Agent').replace(/\|/g, ' ')}; ${relationText}`;
  const newRow = `| **${agent.id}** | ${(agent.name || agent.id).replace(/\|/g, ' ')} | ${roleCell} |`;
  if (lastTableRowIndex >= 0) {
    lines.splice(lastTableRowIndex + 1, 0, newRow);
  } else {
    lines.push('', '| Agent ID | Name | Role |', '|----------|------|------|', newRow, '');
  }
  const newContent = lines.join('\n');
  await workspace.writeWorkspaceFile('agents', newContent, { workspaceRoot, backup: true });
}

/**
 * Derive a stable id from name (slug). Collision: append -2, -3, ...
 */
function deriveId(name, getExistingIds) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32) || 'agent';
  const existing = getExistingIds();
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Create full agent. Throws on error.
 * @param {{ name: string, role?: string, parent_id?: string, id?: string }} input - name required; id optional (else derived from name).
 * @returns {{ id: string, name: string, role: string, parent_id: string|null, workspace_path: string, openclaw_agent_id: string, is_coo: number, ... }}
 */
export async function createFullAgent(input) {
  const name = (input.name || 'Unnamed').trim();
  if (!name) throw new Error('name is required');

  const db = getDb();
  const existingIds = new Set(db.prepare('SELECT id FROM agents').all().map((r) => r.id));

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      throw new Error('Could not read openclaw.json: ' + e.message);
    }
  }
  const openclawList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const openclawIds = new Set(openclawList.map((a) => (a.id || '').toLowerCase()).filter(Boolean));

  const getExistingIds = () => new Set([...existingIds, ...openclawIds]);

  let id = (input.id || '').trim().toLowerCase();
  if (!id) id = deriveId(name, getExistingIds);
  else if (existingIds.has(id) || openclawIds.has(id)) throw new Error(`Agent id "${id}" already exists`);

  const role = (input.role || 'Agent').trim();
  const parentId = input.parent_id ? String(input.parent_id).trim() || null : null;

  const workspaceDirName = `workspace-${id}`;
  const WORKSPACE_PATH = join(OPENCLAW_DIR, workspaceDirName);
  if (!existsSync(WORKSPACE_PATH)) mkdirSync(WORKSPACE_PATH, { recursive: true });
  const memoryDir = join(WORKSPACE_PATH, 'memory');
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  // SOUL with session history + tool fallback (aligned with templates)
  const soulMd = `# SOUL — ${name}

You are **${name}**. ${role || 'Specialist agent.'}

## Role

- Fulfill requests in your domain. Report to COO when relevant.

## Memory (avoid redoing recent work)

- **Before responding:** Get your session history for context. Use **sessions_history** with the session key that applies to this run:
  - If the user message says **"Your session key for this run is …"**, use that exact sessionKey (required when delegated or on a Kanban task).
  - Otherwise use \`sessionKey: "agent::${id}:main"\` for Dashboard chat (full format required).
  Then proceed with the task.
- **Before starting a task:** Read MEMORY.md. If you see a recent completion for the same or very similar topic, state that and ask whether to redo or reuse.
- **After completing a task:** Append a brief line to MEMORY.md: topic/request summary and date. Keep only recent entries (e.g. last 20–30).

## Tools

- **kanban_move_status** and other Agent OS tools are **API tools**. Invoke them by tool name with JSON parameters. Do **not** run them as shell commands.
- **Tool choice:** Pick the tool that best matches the user's request (see TOOLS.md). If a tool's response is inadequate (error, empty, or doesn't answer the question), try the next best tool for that context instead of stopping.
- **Browser:** Use the **browser** tool with **profile="openclaw"** only (managed Playwright). Never use profile="chrome" or ask for the Chrome extension unless the user explicitly wants their own Chrome tab attached.

## Boundaries

- Stay in role; escalate when needed. Do not change other agents' SOUL or AGENTS.
- Avoid harmful, biased, or sexual content; keep outputs professional.
`;

  const agentsMd = `# AGENTS — Operating contract (${name})

## Role

${role || 'Specialist.'}

## Priorities

1. Fulfill requests in your domain.
2. Report to COO when relevant.

## Boundaries

- Do not change other agents' SOUL or AGENTS. Escalate approvals to COO/CEO.
`;

  const memoryMd = `# MEMORY — ${name}

## Facts

- Role: ${role || 'Specialist'}.
- Reports to: ${parentId || 'COO'}.
`;

  await workspace.writeWorkspaceFile('soul', soulMd, { workspaceRoot: WORKSPACE_PATH });
  await workspace.writeWorkspaceFile('agents', agentsMd, { workspaceRoot: WORKSPACE_PATH });
  await workspace.writeWorkspaceFile('memory', memoryMd, { workspaceRoot: WORKSPACE_PATH });

  if (!config.agents) config.agents = {};
  if (!config.agents.list) config.agents.list = [];
  const inList = config.agents.list.find((a) => (a.id || '').toLowerCase() === id);
  const agentEntry = {
    id,
    name,
    workspace: toSlash(WORKSPACE_PATH),
    tools: { allow: [...DEFAULT_TOOLS_ALLOW], deny: ['image'] },
  };
  if (!inList) {
    config.agents.list.push(agentEntry);
  } else {
    inList.name = name;
    inList.workspace = toSlash(WORKSPACE_PATH);
    if (!inList.tools) inList.tools = {};
    inList.tools.allow = agentEntry.tools.allow;
    inList.tools.deny = agentEntry.tools.deny;
  }

  if (!config.tools) config.tools = {};
  if (!config.tools.agentToAgent) config.tools.agentToAgent = { enabled: true, allow: [] };
  if (!Array.isArray(config.tools.agentToAgent.allow)) config.tools.agentToAgent.allow = [];
  if (!config.tools.agentToAgent.allow.includes(id)) {
    config.tools.agentToAgent.allow.push(id);
  }

  if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

  const AGENTS_ROOT = join(OPENCLAW_DIR, 'agents');
  for (const dir of [join(AGENTS_ROOT, id, 'agent'), join(AGENTS_ROOT, id, 'sessions')]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      if (dir.endsWith('sessions')) writeFileSync(join(dir, 'sessions.json'), '{}', 'utf8');
    }
  }

  db.prepare(
    `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, role, parentId, WORKSPACE_PATH, id, 0);

  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);

  // Add new agent to COO and parent AGENTS.md so they can delegate by intent
  const coo = db.prepare('SELECT id, workspace_path FROM agents WHERE is_coo = 1').get();
  const parent = parentId ? db.prepare('SELECT id, workspace_path FROM agents WHERE id = ?').get(parentId) : null;
  const agentInfo = { id, name, role: role || 'Agent' };
  const seenRoots = new Set();
  for (const rec of [coo, parent].filter(Boolean)) {
    const root = rec?.workspace_path;
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    try {
      await appendAgentRowToAgentsMd(root, agentInfo, 'reports to you');
    } catch (e) {
      console.warn('appendAgentRowToAgentsMd failed for', rec?.id, e?.message);
    }
  }

  return row;
}
