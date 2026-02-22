/**
 * Ensure TechResearcher agent row has correct role and openclaw_agent_id.
 * Run from backend: node scripts/ensure-techresearcher.js
 * Use after adding new agents from UI if TechResearcher stops responding per role (gateway uses openclaw_agent_id to route to the right workspace).
 */
import { getDb } from '../src/db/schema.js';
import { join } from 'path';

const db = getDb();
const homedir = process.env.USERPROFILE || process.env.HOME || '';
const techPath = process.env.OPENCLAW_WORKSPACE_TECHRESEARCHER || join(homedir, '.openclaw', 'workspace-techresearcher');

const row = db.prepare('SELECT id, name, role, parent_id, openclaw_agent_id, workspace_path FROM agents WHERE id = ?').get('techresearcher');

if (!row) {
  console.log('TechResearcher not in DB. Run: node scripts/seed-techresearcher.js');
  process.exit(1);
}

let updated = false;
if (row.role !== 'Research (AI & Tech)' || row.openclaw_agent_id !== 'techresearcher' || row.parent_id !== 'balserve') {
  db.prepare(
    'UPDATE agents SET name = ?, role = ?, parent_id = ?, openclaw_agent_id = ?, workspace_path = ? WHERE id = ?'
  ).run('TechResearcher', 'Research (AI & Tech)', 'balserve', 'techresearcher', techPath, 'techresearcher');
  updated = true;
  console.log('Repaired TechResearcher row: role, openclaw_agent_id, parent_id, workspace_path.');
}

console.log('TechResearcher:', updated ? 'repaired' : 'OK', JSON.stringify(db.prepare('SELECT id, name, role, openclaw_agent_id, parent_id FROM agents WHERE id = ?').get('techresearcher'), null, 2));
