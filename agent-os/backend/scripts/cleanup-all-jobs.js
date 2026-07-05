/**
 * Remove all job applications, workflow runs, job Kanban tasks, and generated materials.
 * Keeps job_search_profiles and CEO settings intact.
 * Run: node backend/scripts/cleanup-all-jobs.js
 */
import { existsSync, readdirSync, rmSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../src/db/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(__dirname, '../data/job-applicant');

initDb();
const db = getDb();

const jobsBefore = db.prepare('SELECT COUNT(*) AS n FROM job_applications').get().n;
const wfBefore = db.prepare('SELECT COUNT(*) AS n FROM job_workflow_runs').get().n;
const kanbanBefore = db
  .prepare(
    `SELECT COUNT(*) AS n FROM kanban_tasks
     WHERE created_by IN ('job_pipeline', 'job_workflow')
        OR description LIKE '%ceo_review_profile:%'
        OR description LIKE '%workflow_id:%'
        OR description LIKE '%[job_pipeline:%'
        OR title LIKE '%CEO Review%'
        OR title LIKE '%Fit Scoring%'
        OR title LIKE '%Resume Tailoring%'
        OR title LIKE '%Job Discovery%'
        OR title LIKE '%Application%'`
  )
  .get().n;

const jobKanbanIds = db
  .prepare(
    `SELECT id FROM kanban_tasks
     WHERE created_by IN ('job_pipeline', 'job_workflow')
        OR description LIKE '%ceo_review_profile:%'
        OR description LIKE '%workflow_id:%'
        OR description LIKE '%[job_pipeline:%'
        OR title LIKE '%CEO Review%'
        OR title LIKE '%Fit Scoring%'
        OR title LIKE '%Resume Tailoring%'
        OR title LIKE '%Job Discovery%'
        OR title LIKE '%Application Agent%'`
  )
  .all()
  .map((r) => r.id);

db.exec('DELETE FROM job_workflow_steps');
db.exec('DELETE FROM job_workflow_runs');
db.exec('DELETE FROM job_applications');

if (jobKanbanIds.length) {
  const placeholders = jobKanbanIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM task_messages WHERE task_id IN (${placeholders})`).run(...jobKanbanIds);
  db.prepare(`DELETE FROM kanban_tasks WHERE id IN (${placeholders})`).run(...jobKanbanIds);
}

// Remove stale job-pipeline delegations (pending/failed block new runs)
const pipelineDelBefore = db
  .prepare(`SELECT COUNT(*) AS n FROM agent_delegation_tasks WHERE prompt LIKE '[job_pipeline%'`)
  .get().n;
db.prepare(`DELETE FROM agent_delegation_tasks WHERE prompt LIKE '[job_pipeline%'`).run();

const pipelineStandupId = db.prepare('SELECT standup_id FROM job_pipeline_state WHERE id = 1').get()?.standup_id;
let standupMsgBefore = 0;
let chatBefore = 0;
if (pipelineStandupId) {
  standupMsgBefore = db.prepare('SELECT COUNT(*) AS n FROM standup_messages WHERE standup_id = ?').get(pipelineStandupId).n;
  db.prepare('DELETE FROM standup_messages WHERE standup_id = ?').run(pipelineStandupId);
}
chatBefore = db
  .prepare(
    `SELECT COUNT(*) AS n FROM chat_turns WHERE agent_id IN ('jobdiscovery','fitscorer','resumetailor','applicationagent','coo')`
  )
  .get().n;
db.prepare(
  `DELETE FROM chat_turns WHERE agent_id IN ('jobdiscovery','fitscorer','resumetailor','applicationagent','coo')`
).run();

db.prepare(
  `UPDATE job_pipeline_state
   SET enabled = 0, last_discovery_at = NULL, active_workflow_run_id = NULL, updated_at = datetime('now')
   WHERE id = 1`
).run();

function deleteFilesInDir(dir, exts) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      n += deleteFilesInDir(p, exts);
      try {
        if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
      } catch (_) {}
    } else if (exts.some((e) => name.toLowerCase().endsWith(e))) {
      unlinkSync(p);
      n++;
    }
  }
  return n;
}

const pdfCount = deleteFilesInDir(join(dataRoot, 'resumes'), ['.pdf', '.md']);
const csvCount = deleteFilesInDir(join(dataRoot, 'spreadsheets'), ['.csv', '.md', '.json']);

const jobsAfter = db.prepare('SELECT COUNT(*) AS n FROM job_applications').get().n;
const kanbanAfter = db.prepare('SELECT COUNT(*) AS n FROM kanban_tasks').get().n;

console.log('Cleanup complete (profiles preserved):');
console.log(`  Job applications: ${jobsBefore} → ${jobsAfter}`);
console.log(`  Workflow runs: ${wfBefore} → 0`);
console.log(`  Job Kanban tasks removed: ${kanbanBefore}`);
console.log(`  Job pipeline delegations removed: ${pipelineDelBefore}`);
console.log(`  Pipeline standup messages removed: ${standupMsgBefore}`);
console.log(`  Agent chat turns removed: ${chatBefore}`);
console.log(`  Kanban tasks remaining: ${kanbanAfter}`);
console.log(`  Generated files removed: ${pdfCount} resume/cover, ${csvCount} spreadsheet`);
