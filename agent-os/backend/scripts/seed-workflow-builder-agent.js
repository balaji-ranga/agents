/**
 * Seed Workflow Builder agent (workflowbuilder).
 * Usage: node scripts/seed-workflow-builder-agent.js
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { initDb, getDb } from '../src/db/schema.js';

initDb();
const db = getDb();

const WORKSPACE_PATH =
  process.env.OPENCLAW_WORKSPACE_WORKFLOWBUILDER ||
  join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'workspace-workflowbuilder');

const TEMPLATES_DIR = join(__dirname, '..', '..', 'openclaw-workspace-templates', 'workflowbuilder');

function ensureWorkspace() {
  if (!existsSync(WORKSPACE_PATH)) mkdirSync(WORKSPACE_PATH, { recursive: true });
  for (const name of ['SOUL.md', 'AGENTS.md', 'TOOLS.md']) {
    const tpl = join(TEMPLATES_DIR, name);
    const dest = join(WORKSPACE_PATH, name);
    if (existsSync(tpl) && !existsSync(dest)) copyFileSync(tpl, dest);
    else if (existsSync(tpl)) writeFileSync(dest, readFileSync(tpl, 'utf8'), 'utf8');
  }
}

export function seedWorkflowBuilderAgent() {
  ensureWorkspace();
  const coo = db.prepare('SELECT id FROM agents WHERE is_coo = 1 LIMIT 1').get();
  const parentId = coo?.id || 'balserve';
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get('workflowbuilder');
  if (existing) {
    db.prepare(
      `UPDATE agents SET name = ?, role = ?, parent_id = ?, workspace_path = ?, openclaw_agent_id = ?, is_coo = 0, agent_type = 'standard' WHERE id = ?`
    ).run('Workflow Builder', 'Workflow design & automation', parentId, WORKSPACE_PATH, 'workflowbuilder', 'workflowbuilder');
  } else {
    db.prepare(
      `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo, agent_type)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'standard')`
    ).run(
      'workflowbuilder',
      'Workflow Builder',
      'Workflow design & automation',
      parentId,
      WORKSPACE_PATH,
      'workflowbuilder'
    );
  }
  return db.prepare('SELECT * FROM agents WHERE id = ?').get('workflowbuilder');
}

if (process.argv[1]?.includes('seed-workflow-builder-agent')) {
  const agent = seedWorkflowBuilderAgent();
  console.log('Seeded', agent.id, agent.name, '→', agent.workspace_path);
}
