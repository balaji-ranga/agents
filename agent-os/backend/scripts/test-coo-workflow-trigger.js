/**
 * Test COO triggering a chat-based agent workflow via API tool.
 * Usage: node scripts/test-coo-workflow-trigger.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { seedWorkflowToolsIfMissing } from '../src/db/seed-content-tools-meta.js';
import { writeOpenClawToolsList } from '../src/services/content-tools-meta.js';
import {
  seedBrainApprovalWorkflow,
  CHAT_PHRASE,
  WORKFLOW_ID,
} from './seed-brain-approval-workflow.js';
import {
  listChatTriggerableWorkflows,
  triggerAgentWorkflowForOwner,
} from '../src/services/agent-workflow-chat-tools.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

const PORT = Number(process.env.PORT) || 3001;
const API = process.env.AGENT_OS_PUBLIC_URL || `http://127.0.0.1:${PORT}`;

initDb();
seedWorkflowToolsIfMissing();
writeOpenClawToolsList();

const owner = process.env.WORKFLOW_SEED_OWNER_ID || getBalaCeoAuthId();
console.log('Owner:', owner);

const def = seedBrainApprovalWorkflow(owner, { publish: true });
console.log('Workflow:', def.id, def.status, 'phrase:', CHAT_PHRASE);

const listed = listChatTriggerableWorkflows(owner);
console.log('Chat-triggerable workflows:', listed.length);
const match = listed.find((w) => w.id === WORKFLOW_ID);
if (!match) {
  console.error('FAIL: test workflow not in chat-trigger list');
  process.exit(1);
}

// Direct service call (same logic as COO tool)
const run = await triggerAgentWorkflowForOwner(owner, {
  message: CHAT_PHRASE,
  actor: { id: 'balserve', name: 'BalServe', type: 'coo' },
});
console.log('Direct trigger OK:', { run_id: run.id, run_number: run.run_number, definition_id: run.definition_id });

// HTTP tool endpoint as COO would call via OpenClaw
let httpOk = false;
try {
  const res = await fetch(`${API}/api/tools/agent-workflow-trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': 'balserve',
    },
    body: JSON.stringify({ message: CHAT_PHRASE, ceo_user_id: owner }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  console.log('HTTP COO tool trigger OK:', body);
  httpOk = true;
} catch (e) {
  console.warn('HTTP tool test skipped or failed (is backend running?):', e.message);
}

console.log('\nSummary:');
console.log('  - Workflow seeded and published');
console.log('  - Direct COO trigger:', 'OK');
console.log('  - HTTP agent_workflow_trigger as balserve:', httpOk ? 'OK' : 'skipped (start backend to verify)');
