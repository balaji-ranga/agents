/**
 * Seed TechResearcher agent into Agent OS DB.
 * Run from backend: node scripts/seed-techresearcher.js
 */
import { getDb } from '../src/db/schema.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const WORKSPACE_PATH = process.env.OPENCLAW_WORKSPACE_TECHRESEARCHER || join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'workspace-techresearcher');

const db = getDb();
const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get('techresearcher');
if (existing) {
  db.prepare(
    'UPDATE agents SET name = ?, role = ?, workspace_path = ?, parent_id = ?, openclaw_agent_id = ? WHERE id = ?'
  ).run('TechResearcher', 'Research (AI & Tech)', WORKSPACE_PATH, 'balserve', 'techresearcher', 'techresearcher');
  console.log('Updated TechResearcher agent (role and openclaw_agent_id preserved).');
} else {
  db.prepare(
    `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('techresearcher', 'TechResearcher', 'Research (AI & Tech)', 'balserve', WORKSPACE_PATH, 'techresearcher', 0);
  console.log('Seeded TechResearcher agent.');
}
console.log('Workspace path:', WORKSPACE_PATH);
