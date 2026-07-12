/**
 * Simple email workflow: send + restart-resume from in_progress email step.
 * Usage: node scripts/test-email-workflow-resume.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import {
  startAgentWorkflowRun,
  resumeStuckWorkflowRuns,
} from '../src/services/agent-workflow-runner.js';
import { executeEmailTask } from '../src/services/agent-workflow-tasks.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

initDb();
const db = getDb();
const owner = getBalaCeoAuthId();
const to = process.env.WORKFLOW_TEST_EMAIL_TO || 'balaji.x.ranga@gmail.com';
const WORKFLOW_ID = 'test-simple-email-resume';
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else console.log('OK:', msg);
}

async function waitForRun(runId, pred, { timeoutMs = 90000, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const run = store.getRun(runId, owner);
    if (pred(run)) return run;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${label} on run ${runId}`);
}

function buildGraph() {
  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 100 },
        data: {
          label: 'Start',
          triggerModes: ['manual'],
          inputBindings: [],
          outputs: [{ id: 'trigger_input', label: 'Trigger payload' }],
        },
      },
      {
        id: 'email-send',
        type: 'email',
        position: { x: 320, y: 100 },
        data: {
          label: 'Send test email',
          taskConfig: {
            useEnvSmtp: true,
            timeoutMs: 120000,
            timeoutAction: 'fail',
          },
          inputBindings: [
            { id: 'to', label: 'To', mode: 'static', value: to },
            { id: 'cc', label: 'CC', mode: 'static', value: '' },
            {
              id: 'subject',
              label: 'Subject',
              mode: 'static',
              value: 'Agent OS email workflow resume test',
            },
            {
              id: 'body',
              label: 'Body',
              mode: 'static',
              value: `Hello from Agent OS simple email workflow.\nSent at {{now}} — if you see this, SMTP + resume path worked.`,
            },
          ],
          outputs: [
            { id: 'sent', label: 'Sent' },
            { id: 'text', label: 'Summary' },
          ],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger-1', target: 'email-send' }],
  };
}

console.log('SMTP host', process.env.WORKFLOW_SMTP_HOST || '(missing)');
console.log('SMTP port', process.env.WORKFLOW_SMTP_PORT || '(missing)');
console.log('SMTP user set', !!process.env.WORKFLOW_SMTP_USER);
console.log('SMTP pass len', (process.env.WORKFLOW_SMTP_PASS || '').length);
console.log('To', to);

console.log('\n=== 1) Direct SMTP send ===');
const direct = await executeEmailTask(
  {
    to,
    subject: 'Agent OS SMTP direct test',
    body: `Direct executeEmailTask test at ${new Date().toISOString()}`,
    cc: '',
  },
  { useEnvSmtp: true }
);
assert(direct.sent === true, `direct SMTP sent=${direct.sent} error=${direct.error || 'none'}`);
console.log('direct reply', direct.smtpReply || null);

console.log('\n=== 2) Seed / publish simple email workflow ===');
const graph = buildGraph();
// Fix body template — no {{now}} unless template engine supports it; use concrete timestamp
graph.nodes[1].data.inputBindings.find((b) => b.id === 'body').value =
  `Hello from Agent OS simple email workflow.\nSent at ${new Date().toISOString()}.\nSMTP via Brevo.`;

let def = store.getDefinition(WORKFLOW_ID, owner);
if (!def) {
  def = store.createDefinition({
    id: WORKFLOW_ID,
    name: 'Simple Email Resume Test',
    description: 'Trigger → Send Email (env SMTP). Used for resume smoke tests.',
    ownerUserId: owner,
    actor: { id: 'test-email-resume', name: 'Test' },
    graph,
    trigger_modes: ['manual'],
  });
} else {
  store.updateDraft(
    WORKFLOW_ID,
    owner,
    { graph, name: 'Simple Email Resume Test' },
    { id: 'test-email-resume', name: 'Test' }
  );
}
store.publishDefinition(WORKFLOW_ID, owner, { id: 'test-email-resume', name: 'Test' });
def = store.getDefinition(WORKFLOW_ID, owner);
assert(def?.status === 'published', 'workflow published');

console.log('\n=== 3) Full email workflow run ===');
const run1 = await startAgentWorkflowRun(WORKFLOW_ID, owner, {
  trigger: 'manual',
  input: 'resume-email-test',
  actor: { id: 'test-email-resume', name: 'Test' },
});
const done1 = await waitForRun(
  run1.id,
  (r) => ['completed', 'failed'].includes(r.status),
  { timeoutMs: 60000, label: 'email workflow complete' }
);
assert(done1.status === 'completed', `full run status=${done1.status} err=${done1.error_message || ''}`);
const step1 = db
  .prepare(
    `SELECT status, output_json FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = 'email-send'`
  )
  .get(run1.id);
const out1 = JSON.parse(step1?.output_json || '{}');
const sent1 = out1.sent === true || out1.outputs?.find?.((o) => o.id === 'sent')?.value === true || out1.sent === 'true';
// output record shape varies — check string
const out1Text = JSON.stringify(out1);
assert(out1Text.includes('"sent":true') || out1.sent === true, `full run email sent output=${out1Text.slice(0, 240)}`);

console.log('\n=== 4) Simulate restart orphan + resume ===');
const runNumber =
  (db
    .prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS n FROM agent_workflow_runs WHERE definition_id = ?')
    .get(WORKFLOW_ID)?.n) || 1;
db.prepare(
  `INSERT INTO agent_workflow_runs (run_number, definition_id, owner_user_id, status, trigger, context_json)
   VALUES (?, ?, ?, 'running', 'manual', ?)`
).run(
  runNumber,
  WORKFLOW_ID,
  owner,
  JSON.stringify({ node_outputs: {}, initial_input: 'orphan-resume', variables: {} })
);
const runId2 = db.prepare('SELECT id FROM agent_workflow_runs ORDER BY id DESC LIMIT 1').get()?.id;
db.prepare(
  `INSERT INTO agent_workflow_run_steps
   (run_id, node_id, node_type, node_label, status, started_at, completed_at, iteration)
   VALUES (?, 'trigger-1', 'trigger', 'Start', 'completed', datetime('now', '-2 minutes'), datetime('now', '-2 minutes'), 1)`
).run(runId2);
db.prepare(
  `INSERT INTO agent_workflow_run_steps
   (run_id, node_id, node_type, node_label, status, started_at, iteration)
   VALUES (?, 'email-send', 'email', 'Send test email', 'in_progress', datetime('now', '-30 seconds'), 1)`
).run(runId2);

console.log(`Orphan run ${runId2} email in_progress — calling resumeStuckWorkflowRuns()`);
resumeStuckWorkflowRuns();

const done2 = await waitForRun(
  runId2,
  (r) => ['completed', 'failed'].includes(r.status),
  { timeoutMs: 90000, label: 'resumed email run complete' }
);
assert(done2.status === 'completed', `resume run status=${done2.status} err=${done2.error_message || ''}`);
const step2 = db
  .prepare(
    `SELECT status, output_json, started_at FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = 'email-send'`
  )
  .get(runId2);
const out2Text = step2?.output_json || '';
assert(step2.status === 'completed', `resume email step status=${step2.status}`);
assert(out2Text.includes('"sent":true') || out2Text.includes('"sent": true'), `resume email sent output=${out2Text.slice(0, 240)}`);
console.log('resume started_at preserved?', step2.started_at);

console.log(failed ? `\nFAILED ${failed}` : '\nALL EMAIL WORKFLOW + RESUME TESTS PASSED');
process.exit(failed ? 1 : 0);
