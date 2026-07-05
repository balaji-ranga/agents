/**
 * Repair Banking SVP workflow: tailor PDFs, refresh CEO Kanban, fix stuck steps.
 * Run: node backend/scripts/repair-banking-workflow.js
 */
import { initDb } from '../src/db/schema.js';
import { runJobSearchWorkflowNow } from '../src/services/job-applicant-workflow-run.js';
import { getJobWorkflowTracker } from '../src/services/job-workflow-tracker.js';
import { getDb } from '../src/db/schema.js';

initDb();
const CEO = 'default';
const PROFILE = 'banking-svp-cloud-sg';

const tracker = getJobWorkflowTracker();
const db = getDb();
const failed = db
  .prepare(`SELECT id FROM job_workflow_runs WHERE profile_id = ? AND status = 'failed' ORDER BY id DESC`)
  .all(PROFILE);
for (const { id } of failed) {
  tracker.repairStuckSteps(id);
}

const result = await runJobSearchWorkflowNow(CEO, PROFILE);
console.log('Repair complete:');
console.log('  workflow #', result.workflow_number, 'status', result.workflow?.status);
console.log('  kanban task #', result.kanban_task_id, result.kanban_status);
console.log('  awaiting approval:', result.awaiting_approval_count);
console.log('  tailored in review:', result.review?.tailored_count);
console.log('  next:', result.next_step);
