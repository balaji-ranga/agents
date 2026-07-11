/**
 * E2E: Hello World A2A external agent workflow.
 * Usage: node scripts/test-hello-world-a2a-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import { invokeExternalAgent } from '../src/services/external-agents.js';
import { startAgentWorkflowRun } from '../src/services/agent-workflow-runner.js';
import * as store from '../src/services/agent-workflow-store.js';
import {
  seedHelloWorldA2A,
  HELLO_WORLD_AGENT_ID,
} from './seed-hello-world-a2a.js';

initDb();

const owner = getBalaCeoAuthId();
const authUser = { id: owner, role: 'ceo' };

async function waitForRun(ownerUserId, runId, maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const run = store.getRun(runId, ownerUserId);
    if (!run) throw new Error('Run not found');
    if (['completed', 'failed', 'paused', 'cancelled'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return store.getRun(runId, ownerUserId);
}

console.log('Hello World A2A workflow e2e');

const { agent, workflow } = await seedHelloWorldA2A({ publish: true });
if (agent.status !== 'healthy') throw new Error('Agent not healthy after discover');

console.log('\n— Direct invoke');
const direct = await invokeExternalAgent(HELLO_WORLD_AGENT_ID, owner, {
  message: 'hello world',
  skillId: 'hello_world',
});
console.log('  text:', direct.text);
console.log('  ok:', direct.ok);
if (!direct.ok || !/hello/i.test(direct.text || '')) {
  throw new Error(`Direct invoke failed: ${JSON.stringify(direct)}`);
}
console.log('  OK: direct A2A invoke');

console.log('\n— Workflow run');
const run = await startAgentWorkflowRun(workflow.id, owner, {
  trigger: 'manual',
  input: 'hello world from workflow',
  actor: { id: 'test', name: 'A2A Test' },
});
console.log('  started run #' + run.run_number);

const final = await waitForRun(owner, run.id);
const step = (final.steps || []).find((s) => s.node_id === 'a2a-1');
console.log('  run status:', final.status);
console.log('  a2a step:', step?.status, step?.error_message || '');
const outText =
  step?.output?.text ||
  (step?.output_json && JSON.parse(step.output_json)?.text) ||
  '';
console.log('  output:', String(outText).slice(0, 200));

if (final.status !== 'completed') {
  throw new Error(`Workflow run failed: ${final.status} — ${step?.error_message || 'no step error'}`);
}
if (!/hello/i.test(String(outText))) {
  throw new Error(`Expected Hello World in output, got: ${outText}`);
}
console.log('  OK: workflow completed with A2A response');

console.log('\nAll Hello World A2A tests passed.');
