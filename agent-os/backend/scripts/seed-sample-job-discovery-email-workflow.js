/**
 * Seed the "Job Discovery → Email" sample workflow for CEO user(s).
 * Default owner: ceo-bala (Balaji). Override: WORKFLOW_SEED_OWNER_ID=ceo-bala
 *
 * Usage: node scripts/seed-sample-job-discovery-email-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import { notifySchedulerConfigurationChanged } from '../src/services/agent-workflow-scheduler.js';

initDb();

export const WORKFLOW_ID = 'sample-job-discovery-email';
export const CHAT_PHRASE = 'run job discovery email workflow';

export function buildSampleJobDiscoveryEmailGraph(emailTo = 'workflow-test@example.com') {
  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 120 },
        data: {
          label: 'Start',
          triggerModes: ['manual', 'chat'],
          scheduleCron: '',
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
            'Produce an email body with a warm greeting and bullet list of job listings you discovered (LinkedIn / JobStreet). Plain text only — no markdown fences. Include company names and role titles.\n\n{{input}}',
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
            { id: 'to', label: 'To address', mode: 'static', value: emailTo },
            { id: 'cc', label: 'CC', mode: 'static', value: '' },
            { id: 'subject', label: 'Subject', mode: 'static', value: 'Job Discovery — daily listings' },
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

export function seedSampleWorkflowForOwner(ownerUserId, { publish = true, emailTo } = {}) {
  const actor = { id: 'seed-script', name: 'Seed Script', type: 'system' };
  const graph = buildSampleJobDiscoveryEmailGraph(
    emailTo || process.env.WORKFLOW_TEST_EMAIL_TO || 'workflow-test@example.com'
  );
  const ownerScopedId = ownerUserId === (process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala')
    ? WORKFLOW_ID
    : `${WORKFLOW_ID}-${ownerUserId}`;

  const patch = {
    name: 'Job Discovery → Email',
    description:
      'Sample workflow: Job Discovery agent produces email body → Send Email task (static To + dynamic body). Triggers: manual and chat phrase.',
    graph,
    trigger_modes: ['manual', 'chat'],
    schedule_cron: '',
    chat_trigger_phrase: CHAT_PHRASE,
  };

  const existingGlobal = getDb().prepare('SELECT * FROM agent_workflow_definitions WHERE id = ?').get(WORKFLOW_ID);
  const existing = store.getDefinition(ownerScopedId, ownerUserId);

  if (existingGlobal && existingGlobal.owner_user_id !== ownerUserId && ownerScopedId === WORKFLOW_ID) {
    getDb()
      .prepare(
        `UPDATE agent_workflow_definitions SET owner_user_id = ?, name = ?, description = ?, draft_graph_json = ?,
         schedule_cron = ?, chat_trigger_phrase = ?, trigger_modes = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        ownerUserId,
        patch.name,
        patch.description,
        JSON.stringify(graph),
        patch.schedule_cron,
        patch.chat_trigger_phrase,
        patch.trigger_modes.join(','),
        WORKFLOW_ID
      );
    store.appendAudit(WORKFLOW_ID, {
      action: 'transferred',
      summary: `Transferred sample workflow to ${ownerUserId}`,
      changedBy: actor.id,
      changedByName: actor.name,
    });
  } else if (existing) {
    store.updateDraft(ownerScopedId, ownerUserId, patch, actor);
  } else if (existingGlobal) {
    throw new Error(`Workflow id ${WORKFLOW_ID} already exists for another owner`);
  } else {
    getDb()
      .prepare(
        `INSERT INTO agent_workflow_definitions (id, name, description, owner_user_id, draft_graph_json, status, schedule_cron, chat_trigger_phrase, trigger_modes)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      )
      .run(
        ownerScopedId,
        patch.name,
        patch.description,
        ownerUserId,
        JSON.stringify(graph),
        patch.schedule_cron,
        patch.chat_trigger_phrase,
        patch.trigger_modes.join(',')
      );
    store.appendAudit(ownerScopedId, {
      action: 'created',
      summary: 'Seeded sample Job Discovery → Email workflow',
      changedBy: actor.id,
      changedByName: actor.name,
    });
  }

  if (publish) {
    store.publishDefinition(ownerScopedId, ownerUserId, actor);
  }

  notifySchedulerConfigurationChanged();
  return store.getDefinition(ownerScopedId, ownerUserId);
}

function resolveSeedOwners() {
  const single = process.env.WORKFLOW_SEED_OWNER_ID?.trim();
  if (single) return [single];
  const balaId = process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';
  const bala = getDb().prepare('SELECT id FROM platform_users WHERE id = ?').get(balaId);
  if (bala) return [balaId];
  return getDb().prepare(`SELECT id FROM platform_users WHERE role = 'ceo'`).all().map((r) => r.id);
}

if (process.argv[1]?.includes('seed-sample-job-discovery-email-workflow')) {
  const owners = resolveSeedOwners();
  console.log('Seeding sample workflow for:', owners.join(', '));
  for (const ownerUserId of owners) {
    const def = seedSampleWorkflowForOwner(ownerUserId, { publish: true });
    console.log(`  ✓ ${def.id} (${def.status}) — owner ${ownerUserId}`);
    console.log(`    Triggers: ${def.trigger_modes?.join(', ') || 'manual'}`);
    if (def.schedule_cron) console.log(`    Schedule cron: ${def.schedule_cron}`);
  }
  console.log('\nOpen Workflows in the UI or edit at /workflows/' + WORKFLOW_ID + '/edit');
}
