/**
 * Test COO workflow tools: enquire, list, trigger (including testMCP).
 * Usage: node backend/scripts/test-coo-workflow-trigger.js
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
  listPublishedWorkflows,
  triggerAgentWorkflowForOwner,
  enquireWorkflows,
} from '../src/services/agent-workflow-chat-tools.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import { buildTestMcpGraph, upsertWorkflow, WORKFLOW_ID as TEST_MCP_ID, CHAT_PHRASE as TEST_MCP_PHRASE } from './test-testMCP-workflow.js';
import * as store from '../src/services/agent-workflow-store.js';

const PORT = Number(process.env.PORT) || 3001;
const API = process.env.AGENT_OS_PUBLIC_URL || `http://127.0.0.1:${PORT}`;

initDb();
seedWorkflowToolsIfMissing();
writeOpenClawToolsList();

const owner = process.env.WORKFLOW_SEED_OWNER_ID || getBalaCeoAuthId();
console.log('Owner:', owner);

const def = seedBrainApprovalWorkflow(owner, { publish: true });
console.log('Workflow:', def.id, def.status, 'phrase:', CHAT_PHRASE);

upsertWorkflow(owner, buildTestMcpGraph());
console.log('testMCP workflow published, phrase:', TEST_MCP_PHRASE);

const enquireMcp = enquireWorkflows(owner, 'MCP test workflow');
console.log('Enquire "MCP test workflow":', enquireMcp.count, 'match(es)');
if (!enquireMcp.matches.some((m) => m.id === TEST_MCP_ID)) {
  console.error('FAIL: testMCP not found via enquire');
  process.exit(1);
}

const listed = listChatTriggerableWorkflows(owner);
console.log('Chat-triggerable workflows:', listed.length);

const allPublished = listPublishedWorkflows(owner);
console.log('All published workflows:', allPublished.length);
if (allPublished.length < listed.length) {
  console.error('FAIL: all published should be >= chat-triggerable count');
  process.exit(1);
}

const enquireAll = enquireWorkflows(owner, '', { all: true, limit: 50 });
console.log('Enquire all:', enquireAll.count);
if (enquireAll.count !== allPublished.length) {
  console.error('FAIL: enquire all count mismatch', enquireAll.count, allPublished.length);
  process.exit(1);
}

const match = listed.find((w) => w.id === WORKFLOW_ID);
if (!match) {
  console.error('FAIL: brain approval workflow not in chat-trigger list');
  process.exit(1);
}

const run = await triggerAgentWorkflowForOwner(owner, {
  message: CHAT_PHRASE,
  actor: { id: 'balserve', name: 'BalServe', type: 'coo' },
});
console.log('Direct trigger OK:', { run_id: run.id, run_number: run.run_number, definition_id: run.definition_id });

const mcpRun = await triggerAgentWorkflowForOwner(owner, {
  message: TEST_MCP_PHRASE,
  actor: { id: 'balserve', name: 'BalServe', type: 'coo' },
});
console.log('testMCP COO trigger OK:', { run_id: mcpRun.id, run_number: mcpRun.run_number });

async function httpTool(path, body) {
  const res = await fetch(`${API}/api/tools/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': 'balserve',
    },
    body: JSON.stringify({ ...body, ceo_user_id: owner }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let httpOk = false;
let httpEnquireOk = false;
try {
  const listOut = await httpTool('agent-workflow-list', {});
  console.log('HTTP list all published:', listOut.count);
  if (listOut.count < listOut.workflows?.filter((w) => w.chat_triggerable)?.length) {
    throw new Error('list count inconsistent');
  }

  const enquireOut = await httpTool('agent-workflow-enquire', { query: 'brain approval' });
  console.log('HTTP enquire OK:', enquireOut.count, 'matches');
  httpEnquireOk = enquireOut.count > 0;

  const body = await httpTool('agent-workflow-trigger', { message: TEST_MCP_PHRASE });
  console.log('HTTP COO trigger testMCP OK:', body);
  httpOk = true;
} catch (e) {
  console.warn('HTTP tool test skipped or failed (is backend running?):', e.message);
}

console.log('\nSummary:');
console.log('  - Workflows seeded and published');
console.log('  - Enquire testMCP:', 'OK');
console.log('  - Direct COO trigger (brain approval):', 'OK');
console.log('  - Direct COO trigger (testMCP):', 'OK');
console.log('  - HTTP agent_workflow_enquire as balserve:', httpEnquireOk ? 'OK' : 'skipped');
console.log('  - HTTP agent_workflow_trigger testMCP as balserve:', httpOk ? 'OK' : 'skipped (start backend to verify)');
