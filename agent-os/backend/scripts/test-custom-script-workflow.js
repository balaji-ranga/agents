/**
 * E2E: custom script registration scan + workflow run.
 * Usage: node scripts/test-custom-script-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import { scanCustomScriptSource } from '../src/services/custom-script-scanner.js';
import { createCustomScript, deleteCustomScript } from '../src/services/custom-scripts.js';
import * as store from '../src/services/agent-workflow-store.js';
import { startAgentWorkflowRun } from '../src/services/agent-workflow-runner.js';

const CEO = { id: getBalaCeoAuthId(), role: 'ceo' };
const actor = { id: 'test-custom-script-workflow', name: 'Test' };

const SAFE_PY = `def run_graph(inputs, context=None):
    msg = inputs.get("text") or inputs.get("payload") or ""
    return {"text": f"workflow-ok:{msg}", "count": len(str(msg))}
`;

const HOSTILE_PY = `import subprocess
def run_graph(inputs):
    subprocess.run(["rm", "-rf", "/"])
    return {"text": "bad"}
`;

function assert(name, cond, detail = '') {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`  ✓ ${name}`);
}

async function waitForRun(runId, { timeoutMs = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId, CEO.id);
    if (run && ['completed', 'failed'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Run ${runId} did not finish in ${timeoutMs}ms`);
}

async function main() {
  initDb();
  console.log('\n=== Registration security scan ===');

  const preScan = scanCustomScriptSource({ source: SAFE_PY, language: 'python' });
  assert('pre-scan safe script passes', preScan.passed === true);

  const hostilePre = scanCustomScriptSource({ source: HOSTILE_PY, language: 'python' });
  assert('pre-scan hostile script fails', hostilePre.passed === false);

  const script = await createCustomScript(CEO, {
    name: 'Workflow Echo Script E2E',
    description: 'E2E custom script workflow test',
    language: 'python',
    source: SAFE_PY,
  });
  assert('registration scan_status approved', script.scan_status === 'approved');
  assert('registration status approved', script.status === 'approved');
  assert('scan findings stored', Array.isArray(script.scan_result?.findings));
  if (script.scan_result?.llm_review) {
    assert('LLM review recorded', script.scan_result.llm_review.enabled !== undefined);
  }

  const rejected = await createCustomScript(CEO, {
    name: 'Workflow Hostile Script E2E',
    language: 'python',
    source: HOSTILE_PY,
  });
  assert('hostile registration rejected', rejected.scan_status === 'rejected');

  console.log('\n=== Workflow with custom_script node ===');
  const graph = {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 80 },
        data: { label: 'Start', triggerModes: ['manual'], chatPhrase: '', scheduleCron: '' },
      },
      {
        id: 'script-1',
        type: 'custom_script',
        position: { x: 280, y: 80 },
        data: {
          label: 'Echo Script',
          inputBindings: [
            {
              id: 'text',
              label: 'Input',
              mode: 'dynamic',
              sourceNodeId: 'trigger-1',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            customScriptId: script.id,
            customScriptName: script.name,
          },
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger-1', target: 'script-1' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  const def = store.createDefinition({
    name: `Custom Script E2E ${Date.now()}`,
    description: 'Trigger → custom script sandbox',
    ownerUserId: CEO.id,
    actor,
    graph,
    trigger_modes: ['manual'],
  });
  store.publishDefinition(def.id, CEO.id, actor);

  const run = await startAgentWorkflowRun(def.id, CEO.id, {
    trigger: 'manual',
    input: 'hello-script',
    actor,
  });
  assert('workflow run started', !!run?.id);

  const finished = await waitForRun(run.id);
  assert('workflow run completed', finished.status === 'completed', finished.error_message || finished.status);

  const scriptStep = finished.steps?.find((s) => s.node_id === 'script-1');
  assert('custom_script step completed', scriptStep?.status === 'completed', scriptStep?.error_message);
  const out = scriptStep?.output || {};
  assert('script output text', out.text === 'workflow-ok:hello-script', JSON.stringify(out));

  deleteCustomScript(rejected.id, CEO);
  deleteCustomScript(script.id, CEO);
  store.deleteDefinition(def.id, CEO.id, actor);

  console.log('\nCustom script workflow E2E passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
