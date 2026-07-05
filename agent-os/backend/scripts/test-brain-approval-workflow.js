/**
 * E2E test: Brain + CEO Approval + IF + Agent workflow.
 * Usage: node scripts/test-brain-approval-workflow.js [--reject]
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import {
  startAgentWorkflowRun,
  completeCeoApprovalResponse,
  injectWorkflowStepOutput,
} from '../src/services/agent-workflow-runner.js';
import * as store from '../src/services/agent-workflow-store.js';
import { seedBrainApprovalWorkflow, WORKFLOW_ID } from './seed-brain-approval-workflow.js';
import { processPendingDelegationTasks } from '../src/services/delegation-queue.js';

initDb();
const db = getDb();
const rejectMode = process.argv.includes('--reject');
const ownerUserId = process.env.WORKFLOW_SEED_OWNER_ID || process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Seed & publish workflow ===');
  const def = seedBrainApprovalWorkflow(ownerUserId, { publish: true });
  store.setPaused(WORKFLOW_ID, ownerUserId, false, { id: 'test', name: 'Test' });
  console.log('Workflow:', def.id, def.status);

  console.log('\n=== Start run ===');
  const run = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'manual',
    input: 'Quarterly platform reliability report',
    actor: { id: 'test', name: 'Test Script' },
  });
  console.log('Run id:', run.id, 'status:', run.status);

  let latest = store.getRun(run.id, ownerUserId);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    latest = store.getRun(run.id, ownerUserId);
    const brainStep = latest.steps?.find((s) => s.node_id === 'brain-1');
    if (brainStep?.status === 'completed' || brainStep?.status === 'failed') break;
    if (brainStep?.status === 'in_progress') continue;
  }

  const brainStep = latest.steps?.find((s) => s.node_id === 'brain-1');
  console.log('Brain step:', brainStep?.status, brainStep?.error_message || '');

  if (brainStep?.status === 'failed') {
    console.log('Brain failed (Ollama may be offline) — injecting mock brain output');
    await injectWorkflowStepOutput(run.id, 'brain-1', 'Mock summary: platform reliability is stable with minor risks.');
    latest = store.getRun(run.id, ownerUserId);
  }

  const ceoKanban = db
    .prepare(
      `SELECT id, title, status FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');

  if (!ceoKanban) throw new Error('CEO approval Kanban task not created');
  console.log('\n=== CEO Kanban task ===', ceoKanban.id, ceoKanban.title);

  const decision = rejectMode ? 'reject' : 'approve';
  console.log(`\n=== CEO ${decision} ===`);
  const approval = await completeCeoApprovalResponse({
    kanbanTaskId: ceoKanban.id,
    decision,
    comment: rejectMode ? 'Needs more detail' : 'Looks good, proceed',
    actor: { id: ownerUserId, name: 'CEO Test' },
  });
  console.log('Approval result:', approval);

  await sleep(500);
  latest = store.getRun(run.id, ownerUserId);
  const ifStep = latest.steps?.find((s) => s.node_id === 'if-1');
  console.log('IF step:', ifStep?.status, ifStep?.output);

  if (!rejectMode) {
    const agentStep = latest.steps?.find((s) => s.node_id === 'agent-1');
    if (agentStep?.status === 'in_progress') {
      console.log('Agent delegating — injecting mock agent response');
      await injectWorkflowStepOutput(run.id, 'agent-1', 'Approved workflow acknowledged by Tech Researcher.');
      await processPendingDelegationTasks();
    }
    await sleep(1000);
    latest = store.getRun(run.id, ownerUserId);
  }

  console.log('\n=== Final run ===');
  console.log('Status:', latest.status);
  for (const s of latest.steps || []) {
    console.log(`  ${s.node_id} (${s.node_type}): ${s.status}`);
  }

  const ok =
    rejectMode
      ? latest.steps?.some((s) => s.node_id === 'brain-2' && s.status === 'completed')
      : latest.steps?.some((s) => s.node_id === 'agent-1' && s.status === 'completed');

  if (!ok) {
    console.error('\nTEST FAILED');
    process.exit(1);
  }
  console.log('\nTEST PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
