/**
 * Test workflow describe fast-path for Workflow Builder agent.
 * Usage: node scripts/test-workflow-agent-describe.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import {
  parseDescribeWorkflowIntent,
  extractWorkflowReferenceFromMessage,
  tryDescribeWorkflowResponse,
} from '../src/services/agent-workflow-agent-describe.js';
import { buildHelloWorldA2AGraph, HELLO_WORLD_WORKFLOW_NAME } from './seed-hello-world-a2a.js';
import * as store from '../src/services/agent-workflow-store.js';

initDb();
const owner = getBalaCeoAuthId();
const actor = { id: 'test-workflow-agent-describe', name: 'Test' };

function ensureHelloWorldWorkflow() {
  let def = store.listDefinitions(owner).find((w) => w.name === HELLO_WORLD_WORKFLOW_NAME);
  if (!def) {
    def = store.createDefinition({
      name: HELLO_WORLD_WORKFLOW_NAME,
      description: 'Trigger → external A2A Hello World agent',
      ownerUserId: owner,
      actor,
      graph: buildHelloWorldA2AGraph('a2a-hello-world-agent'),
      trigger_modes: ['manual', 'chat'],
      chat_trigger_phrase: 'run hello world a2a',
    });
  }
  if (def.status !== 'published') {
    def = store.publishDefinition(def.id, owner, actor);
  }
  return def;
}

const workflow = ensureHelloWorldWorkflow();

const cases = [
  'describe the Hello World A2A Test workflow',
  `what nodes are used by
**Hello World A2A Test**
   - **ID:** ${workflow.id}`,
];

for (const msg of cases) {
  const intent = parseDescribeWorkflowIntent(msg);
  if (!intent?.workflow_query && !intent?.workflow_id) {
    throw new Error(`parseDescribeWorkflowIntent failed for: ${msg.slice(0, 80)}`);
  }

  const ref = extractWorkflowReferenceFromMessage(msg);
  const res = tryDescribeWorkflowResponse(owner, null, msg);
  if (!res?.reply) throw new Error(`no describe response for: ${msg.slice(0, 80)}`);
  if (/Brain|MCP tool|mcp-aarna|Agent Node/i.test(res.reply)) {
    throw new Error('describe response hallucinated extra nodes: ' + res.reply.slice(0, 500));
  }
  if (!/externalAgent|External Agent|a2a-1/i.test(res.reply)) {
    throw new Error('describe response missing externalAgent node: ' + res.reply.slice(0, 500));
  }
  if (!/trigger-1/i.test(res.reply)) {
    throw new Error('describe response missing trigger node');
  }
  const nodeTypes = (res.reply.match(/type: `(\w+)`/g) || []).map((s) => s.replace(/type: `|`|/g, ''));
  if (nodeTypes.includes('brain') || nodeTypes.includes('mcp_tool')) {
    throw new Error(`unexpected node types in reply: ${nodeTypes.join(', ')}`);
  }
  if (nodeTypes.length !== 2) {
    throw new Error(`expected exactly 2 nodes, got: ${nodeTypes.join(', ')}`);
  }
  console.log('OK:', msg.split('\n')[0].slice(0, 60), ref);
}

console.log('All describe tests passed.');
