import { getDb, initDb } from '../src/db/schema.js';

initDb();
const db = getDb();
const PROFILE = 'banking-svp-cloud-sg';

console.log('=== Profile ===');
console.log(db.prepare('SELECT id, status, display_name, updated_at FROM job_search_profiles WHERE id=?').get(PROFILE));

console.log('\n=== Jobs by status ===');
const jobs = db.prepare('SELECT job_id, status, title, company, fit_score FROM job_applications WHERE profile_id=? ORDER BY updated_at DESC').all(PROFILE);
const byStatus = {};
for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
console.log('counts', byStatus);
jobs.forEach((j) => console.log(`  ${j.status} score=${j.fit_score} ${j.company} — ${j.title}`));

console.log('\n=== Workflow runs ===');
const wfs = db.prepare(
  'SELECT id, workflow_number, status, kanban_ceo_review_task_id, started_at, updated_at FROM job_workflow_runs WHERE profile_id=? ORDER BY id DESC LIMIT 5'
).all(PROFILE);
console.log(wfs);

if (wfs[0]) {
  console.log('\n=== Workflow steps (latest run) ===');
  const steps = db
    .prepare('SELECT step_key, status, started_at, completed_at, error_json, meta_json FROM job_workflow_steps WHERE workflow_run_id=? ORDER BY step_order')
    .all(wfs[0].id);
  steps.forEach((s) => console.log(s.step_key, s.status, s.error_json || s.meta_json || ''));
}

console.log('\n=== Pipeline state ===');
console.log(db.prepare('SELECT * FROM job_pipeline_state').all());

console.log('\n=== Kanban CEO review ===');
console.log(
  db
    .prepare("SELECT id, status, title, assigned_agent_id FROM kanban_tasks WHERE description LIKE ? ORDER BY id DESC LIMIT 5")
    .all(`%ceo_review_profile:${PROFILE}%`)
);

console.log('\n=== Recent job pipeline delegations ===');
const dels = db
  .prepare("SELECT id, status, agent_id, substr(prompt,1,150) as p FROM delegation_queue WHERE prompt LIKE '%job_pipeline%' ORDER BY id DESC LIMIT 12")
  .all();
dels.forEach((d) => console.log(d.id, d.status, d.agent_id, d.p?.slice(0, 100)));
