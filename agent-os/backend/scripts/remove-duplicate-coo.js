/**
 * Remove any COO agent that is not BalServe (keeps only balserve as is_coo=1).
 * Run from backend: node scripts/remove-duplicate-coo.js
 * Fixes workspace UI deletion failing due to foreign key constraint when a duplicate "COO" agent exists.
 */
import { getDb } from '../src/db/schema.js';

const db = getDb();

const cooAgents = db.prepare('SELECT id, name, is_coo FROM agents WHERE is_coo = 1').all();
const balserve = db.prepare('SELECT id FROM agents WHERE id = ?').get('balserve');

if (cooAgents.length === 0) {
  console.log('No COO agent in DB. Run seed-balserve.js to add BalServe as COO.');
  process.exit(0);
}

if (!balserve) {
  console.log('BalServe not in DB. Add BalServe first (e.g. seed-balserve.js), then run this script.');
  process.exit(1);
}

for (const a of cooAgents) {
  if (a.id === 'balserve') continue;
  const id = a.id;
  console.log('Removing duplicate COO agent:', id, a.name);
  db.prepare('DELETE FROM activities WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM chat_turns WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM standup_responses WHERE agent_id = ?').run(id);
  db.prepare('DELETE FROM agent_delegation_tasks WHERE to_agent_id = ?').run(id);
  db.prepare('UPDATE agents SET parent_id = NULL WHERE parent_id = ?').run(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  console.log('Deleted agent:', id);
}

db.prepare('UPDATE agents SET is_coo = 0').run();
db.prepare('UPDATE agents SET is_coo = 1 WHERE id = ?').run('balserve');
console.log('Done. Only BalServe has is_coo=1.');
