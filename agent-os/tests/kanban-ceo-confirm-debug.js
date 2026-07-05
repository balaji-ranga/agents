/**
 * Debug + smoke: Kanban CEO review confirm via API.
 */
import { initDb, getDb } from '../backend/src/db/schema.js';

function parseProfileIdFromDescription(description) {
  const m = String(description || '').match(/ceo_review_profile:([^\s\n]+)/);
  return m ? m[1].trim() : null;
}

initDb();
const db = getDb();

const API = process.env.API_BASE || 'http://localhost:3001/api';

const tasks = db
  .prepare(
    `SELECT id, title, status, description FROM kanban_tasks
     WHERE status = 'awaiting_confirmation' AND description LIKE 'ceo_review_profile:%'
     ORDER BY id DESC LIMIT 5`
  )
  .all();

console.log('CEO review tasks awaiting_confirmation:', tasks.length);
let failed = 0;
for (const t of tasks) {
  const profileId = parseProfileIdFromDescription(t.description);
  const ceoMatch = t.description.match(/ceo_user_id:\s*(\S+)/);
  const ceoUserId = ceoMatch ? ceoMatch[1] : 'default';
  console.log(`\nTask #${t.id}: ${t.title}`);
  console.log('  profile_id parsed:', profileId);
  console.log('  ceo_user_id:', ceoUserId);

  const pending = db
    .prepare(
      `SELECT COUNT(*) as n FROM job_applications WHERE ceo_user_id = ? AND profile_id = ? AND status = 'awaiting_approval'`
    )
    .get(ceoUserId, profileId);
  console.log('  awaiting_approval jobs:', pending?.n ?? 0);

  const profile = db
    .prepare(`SELECT id, status FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?`)
    .get(ceoUserId, profileId);
  console.log('  profile status:', profile?.status ?? 'NOT FOUND');

  try {
    const res = await fetch(`${API}/tools/job-ceo-review-confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, ceo_user_id: ceoUserId, confirm: true }),
    });
    const body = await res.json().catch(() => ({}));
    console.log('  API status:', res.status, JSON.stringify(body).slice(0, 300));
    if (!res.ok) failed++;
    else {
      const after = db.prepare('SELECT status FROM kanban_tasks WHERE id = ?').get(t.id);
      console.log('  kanban status after:', after?.status);
    }
  } catch (e) {
    console.log('  API error:', e.message);
    failed++;
  }
}

if (tasks.length === 0) {
  console.log('\nNo live tasks — nothing to test');
  process.exit(0);
}

if (failed) {
  console.error(`\n${failed} confirm(s) failed`);
  process.exit(1);
}
console.log('\nOK — confirm API works for live tasks\n');
