/**
 * Simulates UI "Run full workflow" for Banking SVP (same as POST /job-applicant/workflow/run).
 */
import { initDb } from '../src/db/schema.js';
import { runFullJobWorkflow } from '../src/services/job-applicant-workflow-run.js';
import { processPendingDelegationTasks } from '../src/services/delegation-queue.js';
import { getJobWorkflowTracker } from '../src/services/job-workflow-tracker.js';

initDb();
const CEO = 'default';
const PROFILE = 'banking-svp-cloud-sg';

console.log('=== UI flow simulation: runFullJobWorkflow ===\n');
const result = await runFullJobWorkflow(CEO, PROFILE);
console.log('Result mode:', result.mode, '| ok:', result.ok);
console.log('Message:', result.message || result.next_step);

if (['harvest_server', 'existing_tracker', 'full_async'].includes(result.mode)) {
  console.log('\n--- processPendingDelegationTasks (route kick) ---');
  for (let i = 0; i < 3; i++) {
    await processPendingDelegationTasks();
    const wf = getJobWorkflowTracker().getRun(result.workflow_id);
    if (!wf) break;
    const disc = wf.steps.find((s) => s.step_key === 'job_discovery');
    const ceo = wf.steps.find((s) => s.step_key === 'ceo_confirm');
    console.log(`loop ${i + 1}: status=${wf.status} progress=${wf.progress.percent}% discovery=${disc?.status} ceo_confirm=${ceo?.status}`);
    if (ceo?.status === 'in_progress' || wf.status === 'failed') break;
  }
}

const wf = result.workflow_id ? getJobWorkflowTracker().getRun(result.workflow_id) : null;
if (wf) {
  console.log('\n=== Final workflow #' + wf.workflow_number + ' ===');
  for (const s of wf.steps) {
    if (s.status !== 'pending') console.log(`  ${s.step_key}: ${s.status}`);
  }
  process.exit(wf.status === 'failed' ? 1 : 0);
}

process.exit(result.ok ? 0 : 1);
