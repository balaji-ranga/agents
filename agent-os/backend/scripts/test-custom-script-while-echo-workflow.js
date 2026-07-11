/**
 * E2E: custom script → while loop → Postman echo API (3 calls).
 * Usage: node scripts/test-custom-script-while-echo-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import * as store from '../src/services/agent-workflow-store.js';
import { startAgentWorkflowRun } from '../src/services/agent-workflow-runner.js';
import {
  buildCustomScriptWhileEchoGraph,
  SCRIPT_ID,
  WORKFLOW_NAME,
} from './seed-custom-script-while-echo-workflow.js';
import { createCustomScript, deleteCustomScript, getCustomScript } from '../src/services/custom-scripts.js';
import { readFileSync } from 'fs';

const owner = getBalaCeoAuthId();
const authUser = { id: owner, role: 'ceo' };
const actor = { id: 'test-custom-script-while-echo', name: 'Test' };

function assert(name, cond, detail = '') {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`  ✓ ${name}`);
}

async function waitForRun(runId, { timeoutMs = 90000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId, owner);
    if (run && ['completed', 'failed'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Run ${runId} did not finish in ${timeoutMs}ms`);
}

async function ensureSeeded() {
  let script = getCustomScript(SCRIPT_ID, authUser);
  if (!script || script.status !== 'approved') {
    const source = readFileSync(join(__dirname, 'samples', 'workflow-echo-prep.py'), 'utf8');
    try {
      deleteCustomScript(SCRIPT_ID, authUser);
    } catch {
      /* missing */
    }
    script = await createCustomScript(authUser, {
      id: SCRIPT_ID,
      name: 'Workflow Echo Prep',
      language: 'python',
      source,
    });
  }
  assert('script approved', script.status === 'approved' && script.scan_status === 'approved');

  let def = store.listDefinitions(owner).find((w) => w.name === WORKFLOW_NAME);
  if (!def) {
    def = store.createDefinition({
      name: WORKFLOW_NAME,
      description: 'E2E custom script while echo',
      ownerUserId: owner,
      actor,
      graph: buildCustomScriptWhileEchoGraph(SCRIPT_ID),
      trigger_modes: ['manual'],
    });
    def = store.publishDefinition(def.id, owner, actor);
  } else if (def.status !== 'published') {
    def = store.publishDefinition(def.id, owner, actor);
  }
  return def;
}

async function main() {
  initDb();
  console.log('\n=== Seed script + workflow ===');
  const def = await ensureSeeded();
  assert('workflow published', def.status === 'published');

  console.log('\n=== Run workflow ===');
  const run = await startAgentWorkflowRun(def.id, owner, {
    trigger: 'manual',
    input: 'hello-echo-loop',
    actor,
  });
  assert('run started', !!run?.id);

  const finished = await waitForRun(run.id);
  if (finished.status !== 'completed') {
    const failed = finished.steps?.filter((s) => s.status === 'failed') || [];
    console.error('Failed steps:', JSON.stringify(failed, null, 2));
    throw new Error(`Run failed: ${finished.error_message || finished.status}`);
  }
  assert('run completed', finished.status === 'completed');

  const steps = finished.steps || [];
  const scriptStep = steps.find((s) => s.node_id === 'script-1');
  const whileStep = steps.find((s) => s.node_id === 'while-1');
  const apiStep = steps.find((s) => s.node_id === 'api-echo');

  assert('custom script step completed', scriptStep?.status === 'completed');
  assert('script used workflow context', /hello-echo-loop|echo_rounds/.test(JSON.stringify(scriptStep?.output || {})));
  assert('while completed and exited', whileStep?.status === 'completed');
  assert('while ran 3 echo iterations', whileStep?.output?.iterations === 3, JSON.stringify(whileStep?.output));
  assert('while took exit branch', whileStep?.output?.branch === 'exit' || whileStep?.output?.text === 'exit');
  assert('echo API step completed', apiStep?.status === 'completed');
  assert('API returned 2xx', apiStep?.output?.status === 200 || apiStep?.output?.ok === true);

  const body = apiStep?.output?.body;
  const echoed = typeof body === 'object' ? body?.data : body;
  assert('API echoed script payload', JSON.stringify(echoed || '').includes('hello-echo-loop'));

  console.log('\nCustom script while-echo workflow E2E passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
