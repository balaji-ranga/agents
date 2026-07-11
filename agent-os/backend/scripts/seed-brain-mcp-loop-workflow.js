/**
 * Seed workflow: Brain node with MCP tool-calling loop (LLM picks tools).
 * Run: node backend/scripts/seed-brain-mcp-loop-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';

initDb();

export const WORKFLOW_ID = 'test-brain-mcp-loop';
export const MCP_ID = 'mcp-local-random-sse';

function brainProviderConfig() {
  const source = (process.env.BRAIN_MCP_TEST_PROVIDER || 'ollama').toLowerCase();
  if (source === 'openai') {
    return {
      modelSource: 'openai',
      model: process.env.OPENAI_PRIMARY_MODEL || 'gpt-4o-mini',
      maxTokens: 800,
    };
  }
  if (source === 'openrouter') {
    return {
      modelSource: 'openrouter',
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      maxTokens: 800,
    };
  }
  return {
    modelSource: 'ollama',
    apiEndpoint: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    model: process.env.OLLAMA_MODEL || process.env.OPENCLAW_OLLAMA_MODEL || 'llama3.2',
    maxTokens: 800,
  };
}

export function buildBrainMcpLoopGraph() {
  const brainCfg = {
    ...brainProviderConfig(),
    mcpToolCalling: true,
    mcpServerIds: [MCP_ID],
    mcpMaxToolRounds: 6,
    systemPrompt: `You are a workflow test assistant with MCP tools.

Task:
1. Call get_random_number once to obtain a random integer and its parity.
2. If parity is "odd", call emit_random_event once (SSE broadcast test).
3. If parity is "even", do NOT call emit_random_event.
4. Reply with a short JSON summary: {"value":N,"parity":"odd|even","emit_called":true|false,"tools_used":["..."]}

Use MCP tools for steps 1–2; do not invent numbers.`,
  };

  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 120 },
        data: {
          label: 'Start',
          triggerModes: ['manual'],
          scheduleCron: '',
          chatPhrase: '',
        },
      },
      {
        id: 'brain-1',
        type: 'brain',
        position: { x: 280, y: 120 },
        data: {
          label: 'Brain + MCP loop',
          taskConfig: brainCfg,
          outputs: [
            { id: 'text', label: 'Response' },
            { id: 'mcp_tool_calls', label: 'MCP tool calls' },
          ],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger-1', target: 'brain-1' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function seedBrainMcpLoopWorkflow(ownerUserId, { publish = true } = {}) {
  const actor = { id: 'seed-brain-mcp', name: 'Seed script', type: 'system' };
  const graph = buildBrainMcpLoopGraph();
  const patch = {
    name: 'testBrain MCP loop',
    description: 'Brain node: LLM chooses MCP tools (get_random_number / emit_random_event) in a tool loop.',
    graph,
    trigger_modes: ['manual'],
    schedule_cron: '',
    chat_trigger_phrase: '',
  };

  const existing = store.getDefinition(WORKFLOW_ID, ownerUserId);
  if (existing) {
    store.updateDraft(WORKFLOW_ID, ownerUserId, patch, actor);
  } else {
    getDb()
      .prepare(
        `INSERT INTO agent_workflow_definitions (id, name, description, owner_user_id, draft_graph_json, status, trigger_modes)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(
        WORKFLOW_ID,
        patch.name,
        patch.description,
        ownerUserId,
        JSON.stringify(graph),
        patch.trigger_modes.join(',')
      );
  }
  if (publish) return store.publishDefinition(WORKFLOW_ID, ownerUserId, actor);
  return store.getDefinition(WORKFLOW_ID, ownerUserId);
}

if (process.argv[1]?.includes('seed-brain-mcp-loop-workflow')) {
  const owner =
    getDb()
      .prepare(`SELECT id FROM platform_users WHERE role = 'ceo' LIMIT 1`)
      .get()?.id || 'ceo-bala';
  const def = seedBrainMcpLoopWorkflow(owner, { publish: true });
  console.log('Published:', def.id, def.name);
}
