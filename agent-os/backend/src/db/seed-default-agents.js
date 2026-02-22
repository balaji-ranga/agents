/**
 * Seed default agents (BalServe, TechResearcher) if the agents table is empty.
 * Called automatically on backend startup.
 */
import { join } from 'path';
import { getDb } from './schema.js';

const homedir = process.env.USERPROFILE || process.env.HOME || '';

function defaultWorkspace(envKey, subdir) {
  const raw = process.env[envKey];
  if (raw) return String(raw).trim().replace(/^~([/\\]|$)/, (_, sep) => homedir + (sep || ''));
  return join(homedir, '.openclaw', subdir);
}

export function seedDefaultAgentsIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM agents').get();
  if (count.n > 0) return false;

  const balservePath = defaultWorkspace('OPENCLAW_WORKSPACE_BALSERVE', 'workspace-balserve');
  const techPath = defaultWorkspace('OPENCLAW_WORKSPACE_TECHRESEARCHER', 'workspace-techresearcher');

  db.prepare(
    `INSERT INTO agents (id, name, role, workspace_path, openclaw_agent_id, is_coo) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('balserve', 'BalServe', 'COO', balservePath, 'balserve', 1);

  db.prepare(
    `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('techresearcher', 'TechResearcher', 'Research (AI & Tech)', 'balserve', techPath, 'techresearcher', 0);

  console.log('Agent OS: seeded default agents (BalServe, TechResearcher).');
  return true;
}
