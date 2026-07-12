/**
 * One-shot: send email through the simple email workflow.
 * Usage: node scripts/send-one-workflow-email.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import { startAgentWorkflowRun } from '../src/services/agent-workflow-runner.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

initDb();
const db = getDb();
const owner = getBalaCeoAuthId();
const id = 'test-simple-email-resume';
const stamp = new Date().toISOString();
const to = process.env.WORKFLOW_TEST_EMAIL_TO || 'balaji.x.ranga@gmail.com';

let def = store.getDefinition(id, owner);
if (!def) {
  console.error('Workflow missing. Seed with: node scripts/test-email-workflow-resume.js');
  process.exit(1);
}

const graph = structuredClone(def.draft_graph || def.published_graph);
const email = graph.nodes.find((n) => n.id === 'email-send' || n.type === 'email');
if (!email) {
  console.error('No email node in workflow');
  process.exit(1);
}

for (const b of email.data.inputBindings || []) {
  if (b.id === 'to') b.value = to;
  if (b.id === 'subject') b.value = `Agent OS workflow email test ${stamp}`;
  if (b.id === 'body') {
    b.value = [
      `Sent via workflow run at ${stamp}.`,
      `From WORKFLOW_SMTP_FROM=${process.env.WORKFLOW_SMTP_FROM || ''}`,
      'If you see this, the workflow email path works.',
    ].join('\n');
  }
}
email.data.taskConfig = {
  ...(email.data.taskConfig || {}),
  useEnvSmtp: true,
  timeoutMs: 120000,
};

store.updateDraft(id, owner, { graph }, { id: 'workflow-email-test', name: 'Test' });
store.publishDefinition(id, owner, { id: 'workflow-email-test', name: 'Test' });

const run = await startAgentWorkflowRun(id, owner, {
  trigger: 'manual',
  input: `workflow-email-test ${stamp}`,
  actor: { id: 'workflow-email-test', name: 'Test' },
});
console.log('started run', run.id);
console.log('look for subject: Agent OS workflow email test', stamp);

const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  const r = store.getRun(run.id, owner);
  if (['completed', 'failed'].includes(r.status)) {
    const step = db
      .prepare(
        `SELECT status, output_json, error_message
         FROM agent_workflow_run_steps
         WHERE run_id = ? AND node_type = 'email'
         ORDER BY id DESC LIMIT 1`
      )
      .get(run.id);
    console.log('run', r.status, r.error_message || '');
    console.log('email step', step?.status, step?.error_message || '');
    console.log('output', step?.output_json);
    const ok = r.status === 'completed' && String(step?.output_json || '').includes('"sent":true');
    process.exit(ok ? 0 : 1);
  }
  await new Promise((res) => setTimeout(res, 400));
}

console.error('timeout waiting for workflow');
process.exit(1);
