/**
 * Seed "Brain + CEO Approval" test workflow.
 * Usage: node scripts/seed-brain-approval-workflow.js
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

export const WORKFLOW_ID = 'test-brain-approval';
export const CHAT_PHRASE = 'run brain approval test';

export function buildBrainApprovalTestGraph() {
  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 160 },
        data: {
          label: 'Start',
          triggerModes: ['manual', 'chat'],
          scheduleCron: '',
          chatPhrase: CHAT_PHRASE,
        },
      },
      {
        id: 'brain-1',
        type: 'brain',
        position: { x: 240, y: 160 },
        data: {
          label: 'Brain — draft',
          inputBindings: [
            {
              id: 'userMessage',
              label: 'User message',
              mode: 'dynamic',
              sourceNodeId: 'trigger-1',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            modelSource: 'ollama',
            apiEndpoint: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
            apiKey: '',
            model: process.env.OLLAMA_MODEL || 'llama3.2',
            maxTokens: 256,
            systemPrompt:
              'Write a 2-sentence executive summary for CEO approval. Topic: {{input}}. Be concise.',
            mcpToolCalling: false,
            mcpServerIds: [],
            mcpToolAllowlist: [],
            mcpMaxToolRounds: 8,
            httpHeadersJson: '{}',
          },
        },
      },
      {
        id: 'ceo-1',
        type: 'ceo_approval',
        position: { x: 460, y: 160 },
        data: {
          label: 'CEO Approval',
          inputBindings: [
            {
              id: 'summary',
              label: 'Summary',
              mode: 'dynamic',
              sourceNodeId: 'brain-1',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            title: 'Approve Brain draft',
            instructions: 'Review the AI summary below. Approve to continue or reject to stop.',
          },
        },
      },
      {
        id: 'if-1',
        type: 'if',
        position: { x: 680, y: 160 },
        data: {
          label: 'If approved',
          taskConfig: {
            sourceNodeId: 'ceo-1',
            sourceOutputKey: 'decision',
            operator: 'eq',
            compareValue: 'approved',
          },
        },
      },
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 900, y: 80 },
        data: {
          label: 'Tech Researcher',
          agentId: 'techresearcher',
          agentName: 'Tech Researcher',
          prompt: 'Acknowledge this approved workflow output in one sentence:\n\n{{input}}',
          inputBindings: [
            {
              id: 'prompt',
              mode: 'dynamic',
              sourceNodeId: 'brain-1',
              sourceOutputKey: 'text',
            },
          ],
        },
      },
      {
        id: 'brain-2',
        type: 'brain',
        position: { x: 900, y: 240 },
        data: {
          label: 'Brain — rejected note',
          inputBindings: [
            {
              id: 'userMessage',
              mode: 'dynamic',
              sourceNodeId: 'ceo-1',
              sourceOutputKey: 'comment',
            },
          ],
          taskConfig: {
            modelSource: 'ollama',
            apiEndpoint: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
            model: process.env.OLLAMA_MODEL || 'llama3.2',
            maxTokens: 128,
            systemPrompt: 'Write one sentence acknowledging the CEO rejection.',
            mcpToolCalling: false,
            mcpServerIds: [],
            mcpToolAllowlist: [],
            mcpMaxToolRounds: 8,
            httpHeadersJson: '{}',
          },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'brain-1' },
      { id: 'e2', source: 'brain-1', target: 'ceo-1' },
      { id: 'e3', source: 'ceo-1', target: 'if-1' },
      { id: 'e4', source: 'if-1', target: 'agent-1', sourceHandle: 'true' },
      { id: 'e5', source: 'if-1', target: 'brain-2', sourceHandle: 'false' },
    ],
    viewport: { x: 0, y: 0, zoom: 0.85 },
  };
}

export function seedBrainApprovalWorkflow(ownerUserId, { publish = true } = {}) {
  const actor = { id: 'seed', name: 'Seed', type: 'system' };
  const graph = buildBrainApprovalTestGraph();
  const patch = {
    name: 'Brain + CEO Approval Test',
    description: 'Test workflow: Brain → CEO Kanban approval → IF → Agent (approved) or Brain (rejected).',
    graph,
    trigger_modes: ['manual', 'chat'],
    schedule_cron: '',
    chat_trigger_phrase: CHAT_PHRASE,
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
        '',
        CHAT_PHRASE,
        'manual,chat'
      );
  }
  if (publish) store.publishDefinition(WORKFLOW_ID, ownerUserId, actor);
  notifySchedulerConfigurationChanged();
  return store.getDefinition(WORKFLOW_ID, ownerUserId);
}

if (process.argv[1]?.includes('seed-brain-approval-workflow')) {
  const owner = process.env.WORKFLOW_SEED_OWNER_ID || process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';
  const def = seedBrainApprovalWorkflow(owner, { publish: true });
  console.log('Seeded', def.id, def.status);
}
