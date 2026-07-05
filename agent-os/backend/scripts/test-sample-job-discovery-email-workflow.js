/**
 * E2E test: Job Discovery agent → Send Email workflow.
 * - Creates & publishes sample workflow (chat + every-minute schedule)
 * - Runs workflow, injects step1 output if agent still pending (fast path)
 * - Verifies email step attempted (SMTP optional)
 *
 * Usage: node scripts/test-sample-job-discovery-email-workflow.js
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
  injectWorkflowStepOutput,
} from '../src/services/agent-workflow-runner.js';
import { notifySchedulerConfigurationChanged } from '../src/services/agent-workflow-scheduler.js';
import { processPendingDelegationTasks } from '../src/services/delegation-queue.js';

initDb();

const WORKFLOW_ID = 'sample-job-discovery-email';
const CHAT_PHRASE = 'run job discovery email workflow';
const SAMPLE_EMAIL_BODY = `Hello,

Here are today's discovered opportunities:

• Senior Cloud Architect — DBS Bank (LinkedIn)
• VP Engineering — Standard Chartered (JobStreet)
• Head of Platform — OCBC (LinkedIn)

Best regards,
Job Discovery Agent`;

function getOwnerUserId() {
  const ceo = getDb().prepare(`SELECT id FROM platform_users WHERE role = 'ceo' LIMIT 1`).get();
  return ceo?.id || 'ceo-bala';
}

function buildSampleGraph() {
  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 120 },
        data: {
          label: 'Start',
          triggerModes: ['manual', 'schedule', 'chat'],
          scheduleCron: '* * * * *',
          chatPhrase: CHAT_PHRASE,
          inputBindings: [],
          outputs: [{ id: 'trigger_input', label: 'Trigger payload' }],
        },
      },
      {
        id: 'agent-discovery',
        type: 'agent',
        position: { x: 280, y: 120 },
        data: {
          label: 'Job Discovery',
          agentId: 'jobdiscovery',
          agentName: 'Job Discovery',
          prompt:
            'Produce an email body with a warm greeting and bullet list of real or sample job listings for Singapore banking/cloud roles. Plain text only — no markdown fences.\n\n{{input}}',
          inputBindings: [
            {
              id: 'prompt',
              label: 'Task / prompt',
              mode: 'dynamic',
              sourceNodeId: 'trigger-1',
              sourceOutputKey: 'text',
              value: '',
            },
          ],
          outputs: [{ id: 'text', label: 'Agent response' }],
        },
      },
      {
        id: 'email-send',
        type: 'email',
        position: { x: 540, y: 120 },
        data: {
          label: 'Email discovered jobs',
          inputBindings: [
            {
              id: 'to',
              label: 'To address',
              mode: 'static',
              value: process.env.WORKFLOW_TEST_EMAIL_TO || 'workflow-test@example.com',
            },
            {
              id: 'cc',
              label: 'CC',
              mode: 'static',
              value: '',
            },
            {
              id: 'subject',
              label: 'Subject',
              mode: 'static',
              value: 'Job Discovery — daily listings',
            },
            {
              id: 'body',
              label: 'Email body',
              mode: 'dynamic',
              sourceNodeId: 'agent-discovery',
              sourceOutputKey: 'text',
              value: '',
            },
          ],
          outputs: [
            { id: 'sent', label: 'Sent' },
            { id: 'attempted', label: 'Attempted' },
            { id: 'messageId', label: 'Message ID' },
            { id: 'error', label: 'Error' },
          ],
          taskConfig: {
            useEnvSmtp: true,
            smtpHost: process.env.WORKFLOW_SMTP_HOST || '',
            smtpPort: Number(process.env.WORKFLOW_SMTP_PORT || 587),
            smtpSecure: false,
            smtpUser: process.env.WORKFLOW_SMTP_USER || '',
            smtpPass: process.env.WORKFLOW_SMTP_PASS || '',
            fromAddress: process.env.WORKFLOW_SMTP_FROM || 'agent-os@localhost',
          },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'agent-discovery' },
      { id: 'e2', source: 'agent-discovery', target: 'email-send' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const ownerUserId = getOwnerUserId();
  const actor = { id: ownerUserId, name: 'test-script', type: 'system' };
  const graph = buildSampleGraph();

  console.log('Owner:', ownerUserId);

  const existing = store.getDefinition(WORKFLOW_ID, ownerUserId);
  if (existing) {
    store.updateDraft(
      WORKFLOW_ID,
      ownerUserId,
      {
        name: 'Job Discovery → Email',
        description: 'Sample: jobdiscovery agent then SMTP email',
        graph,
        trigger_modes: ['manual', 'schedule', 'chat'],
        schedule_cron: '* * * * *',
        chat_trigger_phrase: CHAT_PHRASE,
      },
      actor
    );
    console.log('Updated existing workflow:', WORKFLOW_ID);
  } else {
    getDb()
      .prepare(
        `INSERT INTO agent_workflow_definitions (id, name, description, owner_user_id, draft_graph_json, status, schedule_cron, chat_trigger_phrase, trigger_modes)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      )
      .run(
        WORKFLOW_ID,
        'Job Discovery → Email',
        'Sample: jobdiscovery agent then SMTP email',
        ownerUserId,
        JSON.stringify(graph),
        '* * * * *',
        CHAT_PHRASE,
        'manual,schedule,chat'
      );
    store.appendAudit(WORKFLOW_ID, { action: 'created', summary: 'Test script created workflow', changedBy: actor.id });
    console.log('Created workflow:', WORKFLOW_ID);
  }

  const published = store.publishDefinition(WORKFLOW_ID, ownerUserId, actor);
  console.log('Published:', published.status);

  notifySchedulerConfigurationChanged();
  console.log('Scheduler refreshed (every minute + chat phrase registered)');

  const run = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'manual',
    input: 'Manual test run for job discovery email workflow',
    actor,
  });
  console.log('Started run #' + run.run_number, 'id=', run.id);

  let finalRun = run;
  const maxWait = Number(process.env.WORKFLOW_TEST_AGENT_WAIT_MS || 8000);
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await processPendingDelegationTasks().catch(() => {});
    finalRun = store.getRun(run.id, ownerUserId);
    const discoveryStep = finalRun.steps?.find((s) => s.node_id === 'agent-discovery');
    if (discoveryStep?.status === 'completed') {
      console.log('Job discovery step completed via agent');
      break;
    }
    if (discoveryStep?.status === 'failed') {
      console.warn('Discovery agent failed — injecting sample output for email step test');
      await injectWorkflowStepOutput(run.id, 'agent-discovery', SAMPLE_EMAIL_BODY);
      finalRun = store.getRun(run.id, ownerUserId);
      break;
    }
    await sleep(1500);
  }

  const discoveryStep = finalRun.steps?.find((s) => s.node_id === 'agent-discovery');
  if (discoveryStep?.status === 'in_progress' || discoveryStep?.status === 'pending') {
    console.log('Discovery still running — injecting sample email body for step 2 test');
    await injectWorkflowStepOutput(run.id, 'agent-discovery', SAMPLE_EMAIL_BODY);
    finalRun = store.getRun(run.id, ownerUserId);
  }

  await sleep(2000);
  finalRun = store.getRun(run.id, ownerUserId);

  const emailStep = finalRun.steps?.find((s) => s.node_id === 'email-send');
  console.log('\n--- Results ---');
  console.log('Run status:', finalRun.status);
  console.log('Progress:', finalRun.progress_pct + '%');

  for (const step of finalRun.steps || []) {
    console.log(`\nStep: ${step.node_label} (${step.node_type}) — ${step.status}`);
    if (step.input) {
      const inp = typeof step.input === 'string' ? JSON.parse(step.input) : step.input;
      console.log('  Inputs:', JSON.stringify(inp.summary || inp.resolved || inp, null, 2).slice(0, 500));
    }
    if (step.output) {
      const out = typeof step.output === 'string' ? JSON.parse(step.output) : step.output;
      console.log('  Outputs:', JSON.stringify(out, null, 2).slice(0, 500));
    }
    if (step.error_message) console.log('  Error:', step.error_message);
  }

  const chatRun = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'chat',
    input: `Please ${CHAT_PHRASE} now`,
    actor,
  }).catch((e) => {
    console.warn('Chat trigger run skipped:', e.message);
    return null;
  });
  if (chatRun) console.log('\nChat-triggered run started:', chatRun.id);

  const ok =
    published?.status === 'published' &&
    emailStep &&
    ['completed', 'in_progress'].includes(emailStep.status) &&
    (() => {
      if (!emailStep.output) return false;
      const out = typeof emailStep.output === 'string' ? JSON.parse(emailStep.output) : emailStep.output;
      return out.attempted === true || out.sent === true || out.error != null;
    })();

  if (ok) {
    console.log('\n✓ TEST PASSED — workflow published, run executed, email step attempted');
    process.exit(0);
  }

  console.error('\n✗ TEST FAILED — check steps above');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
