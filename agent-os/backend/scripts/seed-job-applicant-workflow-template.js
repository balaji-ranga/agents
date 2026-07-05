/**
 * Seed the Job Applicant Pipeline workflow template for CEO user(s).
 * Usage: node scripts/seed-job-applicant-workflow-template.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import {
  buildJobApplicantPipelineGraph,
  JOB_APPLICANT_TEMPLATE_ID,
  JOB_APPLICANT_CHAT_PHRASE,
} from '../src/services/agent-workflow-templates.js';
import { notifySchedulerConfigurationChanged } from '../src/services/agent-workflow-scheduler.js';

initDb();

export const WORKFLOW_ID = JOB_APPLICANT_TEMPLATE_ID;

export function seedJobApplicantWorkflowForOwner(ownerUserId, { publish = false } = {}) {
  const actor = { id: 'seed-script', name: 'Seed Script', type: 'system' };
  const graph = buildJobApplicantPipelineGraph();
  const patch = {
    name: 'Job Applicant Pipeline',
    description:
      'Agent workflow template mirroring Job workflows: discovery → fit scoring → resume tailoring → application. Requires active job profile. CEO Kanban gate after tailoring is external.',
    graph,
    trigger_modes: ['manual', 'chat'],
    schedule_cron: '',
    chat_trigger_phrase: JOB_APPLICANT_CHAT_PHRASE,
  };

  const existing = store.getDefinition(WORKFLOW_ID, ownerUserId);
  if (existing) {
    store.updateDraft(WORKFLOW_ID, ownerUserId, patch, actor);
  } else {
    getDb()
      .prepare(
        `INSERT INTO agent_workflow_definitions (id, name, description, owner_user_id, draft_graph_json, status, schedule_cron, chat_trigger_phrase, trigger_modes)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      )
      .run(
        WORKFLOW_ID,
        patch.name,
        patch.description,
        ownerUserId,
        JSON.stringify(graph),
        patch.schedule_cron,
        patch.chat_trigger_phrase,
        patch.trigger_modes.join(',')
      );
    store.appendAudit(WORKFLOW_ID, {
      action: 'created',
      summary: 'Seeded Job Applicant Pipeline workflow template',
      changedBy: actor.id,
      changedByName: actor.name,
    });
  }

  if (publish) {
    store.publishDefinition(WORKFLOW_ID, ownerUserId, actor);
    store.updateTriggers(WORKFLOW_ID, ownerUserId, patch, actor);
  }

  notifySchedulerConfigurationChanged();
  return store.getDefinition(WORKFLOW_ID, ownerUserId);
}

function resolveSeedOwners() {
  const single = process.env.WORKFLOW_SEED_OWNER_ID?.trim();
  if (single) return [single];
  const balaId = process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';
  const bala = getDb().prepare('SELECT id FROM platform_users WHERE id = ?').get(balaId);
  if (bala) return [balaId];
  return getDb().prepare(`SELECT id FROM platform_users WHERE role = 'ceo'`).all().map((r) => r.id);
}

if (process.argv[1]?.includes('seed-job-applicant-workflow-template')) {
  const owners = resolveSeedOwners();
  console.log('Seeding Job Applicant Pipeline template for:', owners.join(', '));
  for (const ownerUserId of owners) {
    const def = seedJobApplicantWorkflowForOwner(ownerUserId, { publish: false });
    console.log(`  ✓ ${def.id} (${def.status}) — owner ${ownerUserId}`);
    console.log(`    Chat trigger: "${JOB_APPLICANT_CHAT_PHRASE}"`);
  }
  console.log('\nCreate from template in UI or edit at /workflows/' + WORKFLOW_ID + '/edit');
}
