import { initDb, getDb } from '../src/db/schema.js';

initDb();
const db = getDb();
const rows = db
  .prepare(
    `SELECT k.id, k.title, k.status, k.assigned_agent_id, a.name AS agent_name, k.created_by, k.created_at
     FROM kanban_tasks k
     LEFT JOIN agents a ON a.id = k.assigned_agent_id
     WHERE k.created_by = 'job_pipeline'
        OR k.title LIKE '%Fit Scoring%'
        OR k.title LIKE '%Resume Tailoring%'
        OR k.title LIKE '%Job Discovery%'
     ORDER BY k.id DESC LIMIT 30`
  )
  .all();
console.log(JSON.stringify(rows, null, 2));
console.log('agents:', db.prepare(`SELECT id, name FROM agents WHERE id IN ('fitscorer','resumetailor','jobdiscovery','applicationagent')`).all());
