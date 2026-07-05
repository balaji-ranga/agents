import { initDb, getDb } from '../src/db/schema.js';
import { getPipelineStatus } from '../src/services/job-applicant-pipeline.js';

initDb();
const db = getDb();
const settings = db.prepare('SELECT * FROM job_search_ceo_settings WHERE ceo_user_id = ?').get('default');
const tasks = db
  .prepare(
    `SELECT id, status, title, created_at FROM kanban_tasks WHERE status = 'awaiting_confirmation' ORDER BY id DESC LIMIT 5`
  )
  .all();
const profile = db
  .prepare('SELECT id, display_name, status FROM job_search_profiles WHERE id = ?')
  .get('banking-svp-cloud-sg');
console.log(JSON.stringify({ settings, profile, ceoReviewTasks: tasks, pipeline: getPipelineStatus('default') }, null, 2));
