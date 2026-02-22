/**
 * Seed BalServe (COO) agent into Agent OS DB.
 * Run from backend: node scripts/seed-balserve.js
 */
import { getDb } from '../src/db/schema.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const WORKSPACE_PATH = process.env.OPENCLAW_WORKSPACE_BALSERVE || join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'workspace-balserve');

const db = getDb();
const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get('balserve');
if (existing) {
  db.prepare(
    'UPDATE agents SET name = ?, role = ?, workspace_path = ?, openclaw_agent_id = ?, is_coo = ? WHERE id = ?'
  ).run('BalServe', 'COO', WORKSPACE_PATH, 'balserve', 1, 'balserve');
  console.log('Updated BalServe (COO) agent.');
} else {
  db.prepare(
    `INSERT INTO agents (id, name, role, workspace_path, openclaw_agent_id, is_coo) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('balserve', 'BalServe', 'COO', WORKSPACE_PATH, 'balserve', 1);
  console.log('Seeded BalServe (COO) agent.');
}
console.log('Workspace path:', WORKSPACE_PATH);
