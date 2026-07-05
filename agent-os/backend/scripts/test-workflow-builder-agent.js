/**
 * Smoke test Workflow Builder agent chat API.
 * Usage: node scripts/test-workflow-builder-agent.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { seedWorkflowBuilderAgent } from './seed-workflow-builder-agent.js';
import { runWorkflowBuilderChat } from '../src/services/agent-workflow-agent.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

initDb();
seedWorkflowBuilderAgent();

const owner = getBalaCeoAuthId();
console.log('Owner:', owner);

const createRes = await runWorkflowBuilderChat({
  ownerUserId: owner,
  workflowId: null,
  message:
    'Create a workflow named "Agent Demo Flow" with chat phrase "run agent demo flow". Add trigger, then a brain step labeled Draft summary connected from trigger, then CEO approval connected from brain.',
  history: [],
  actor: { id: 'test', name: 'Test' },
});

console.log('Reply:', createRes.reply?.slice(0, 200));
console.log('Workflow id:', createRes.workflow_id);
console.log('Nodes:', createRes.graph_summary?.nodes?.map((n) => `${n.id}(${n.type})`).join(' → '));
console.log('Actions:', createRes.actions_applied);

if (!createRes.workflow_id || (createRes.graph_summary?.node_count || 0) < 2) {
  console.error('FAIL: expected workflow with multiple nodes');
  process.exit(1);
}
console.log('OK');
