/**
 * Clear Kanban tasks, job profiles, jobs, workflow runs, and pipeline state.
 * Run: node scripts/clear-job-applicant-e2e-state.js
 */
import { initDb, getDb } from '../backend/src/db/schema.js';

initDb();
const db = getDb();

const kanbanBefore = db.prepare('SELECT COUNT(*) AS n FROM kanban_tasks').get().n;
const profilesBefore = db.prepare('SELECT COUNT(*) AS n FROM job_search_profiles').get().n;
const jobsBefore = db.prepare('SELECT COUNT(*) AS n FROM job_applications').get().n;

db.exec('DELETE FROM job_workflow_steps');
db.exec('DELETE FROM job_workflow_runs');
db.exec('DELETE FROM job_applications');
db.exec('DELETE FROM job_search_profiles');
db.exec('DELETE FROM job_search_ceo_settings');
db.prepare(
  'UPDATE kanban_tasks SET standup_id = NULL, agent_delegation_task_id = NULL WHERE standup_id IS NOT NULL OR agent_delegation_task_id IS NOT NULL'
).run();
db.exec('DELETE FROM task_messages');
db.exec('DELETE FROM kanban_tasks');
db.prepare("DELETE FROM chat_turns WHERE agent_id IN ('jobdiscovery','fitscorer','resumetailor','applicationagent')").run();
db.prepare("UPDATE job_pipeline_state SET enabled = 0, active_profile_id = NULL, updated_at = datetime('now') WHERE id = 1").run();

console.log('Cleared job applicant E2E state:');
console.log(`  Kanban tasks: ${kanbanBefore} → 0`);
console.log(`  Profiles: ${profilesBefore} → 0`);
console.log(`  Job rows: ${jobsBefore} → 0`);
console.log('  Workflow runs, CEO settings, job-agent chat history cleared');
