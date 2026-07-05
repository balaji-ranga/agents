/** Reset active profile to banking-svp-cloud-sg; remove pdf-smoke test profiles. */
import { getDb, initDb } from '../src/db/schema.js';
import { createJobSearchProfileService } from '../src/services/job-search-profile.js';

initDb();
const db = getDb();
const CEO = 'default';
const BANKING = 'banking-svp-cloud-sg';

const smoke = db.prepare(`SELECT id FROM job_search_profiles WHERE id LIKE 'pdf-smoke%'`).all();
for (const { id } of smoke) {
  db.prepare('DELETE FROM job_applications WHERE profile_id = ?').run(id);
  db.prepare('DELETE FROM job_search_profiles WHERE id = ?').run(id);
  console.log('Deleted smoke profile', id);
}

const profileSvc = createJobSearchProfileService(() => db);
const banking = profileSvc.getProfile(CEO, BANKING);
if (banking?.status === 'active') {
  db.prepare(
    `INSERT INTO job_search_ceo_settings (ceo_user_id, active_profile_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(ceo_user_id) DO UPDATE SET active_profile_id = excluded.active_profile_id, updated_at = datetime('now')`
  ).run(CEO, BANKING);
  console.log('Active profile set to', BANKING);
}

db.prepare(`UPDATE job_pipeline_state SET active_profile_id = ?, ceo_user_id = ? WHERE id = 1`).run(BANKING, CEO);

// Enable full cover letters for banking profile E2E
const row = db.prepare('SELECT intake_json FROM job_search_profiles WHERE id = ?').get(BANKING);
if (row) {
  const intake = JSON.parse(row.intake_json || '{}');
  intake.cover_letter_policy = 'full letter';
  db.prepare('UPDATE job_search_profiles SET intake_json = ? WHERE id = ?').run(JSON.stringify(intake), BANKING);
  console.log('Set cover_letter_policy to full letter');
}

console.log('Settings:', db.prepare('SELECT * FROM job_search_ceo_settings WHERE ceo_user_id = ?').get(CEO));
