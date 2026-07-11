/**
 * E2E: testMCP workflow — chat trigger → MCP symbols → Basic / Login+Bearer / API-key HTTP calls.
 * Run: node backend/scripts/test-testMCP-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import {
  startAgentWorkflowRun,
  tryTriggerWorkflowFromChat,
} from '../src/services/agent-workflow-runner.js';
import { connectMcpServer } from '../src/services/mcp-servers.js';

initDb();

export const WORKFLOW_ID = 'test-mcp';
export const CHAT_PHRASE = 'testMCP';
export const MCP_SERVER_ID = 'mcp-aarna-crypto';
export const MCP_LOCAL_ID = 'mcp-local-random-sse';
export const MCP_TOOL = 'get_available_symbols';
export const MCP_PROMPT = 'random_workflow_brief';
export const MCP_RESOURCE_URI = 'random://stats/summary';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCeoUser() {
  const preferredId = process.env.WORKFLOW_SEED_OWNER_ID || process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';
  const preferred = getDb()
    .prepare(`SELECT id, role, name FROM platform_users WHERE id = ? AND role = 'ceo'`)
    .get(preferredId);
  if (preferred) return { id: preferred.id, role: preferred.role, name: preferred.name };
  const row = getDb().prepare(`SELECT id, role, name FROM platform_users WHERE role = 'ceo' LIMIT 1`).get();
  if (!row) throw new Error('No CEO user in platform_users');
  return { id: row.id, role: row.role, name: row.name };
}

export function buildTestMcpGraph() {
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
          inputBindings: [],
          outputs: [{ id: 'trigger_input', label: 'Trigger payload' }],
        },
      },
      {
        id: 'mcp-symbols',
        type: 'mcp_tool',
        position: { x: 260, y: 160 },
        data: {
          label: 'MCP available symbols',
          inputBindings: [
            {
              id: 'arguments',
              label: 'Tool arguments (JSON)',
              mode: 'static',
              value: '{}',
              sourceNodeId: '',
              sourceOutputKey: 'text',
            },
          ],
          outputs: [
            { id: 'text', label: 'Tool response text' },
            { id: 'result', label: 'Full MCP result JSON' },
            { id: 'ok', label: 'Success' },
          ],
          taskConfig: {
            mcpInvokeKind: 'tool',
            mcpServerId: MCP_SERVER_ID,
            toolName: MCP_TOOL,
            staticArguments: '{}',
            httpHeadersJson: '{}',
          },
        },
      },
      {
        id: 'mcp-prompt',
        type: 'mcp_tool',
        position: { x: 260, y: 320 },
        data: {
          label: 'MCP random prompt',
          inputBindings: [
            {
              id: 'arguments',
              label: 'Arguments (JSON)',
              mode: 'static',
              value: JSON.stringify({ topic: 'testMCP' }),
              sourceNodeId: '',
              sourceOutputKey: 'text',
            },
          ],
          outputs: [
            { id: 'text', label: 'Response text' },
            { id: 'result', label: 'Full MCP result JSON' },
            { id: 'ok', label: 'Success' },
          ],
          taskConfig: {
            mcpInvokeKind: 'prompt',
            mcpServerId: MCP_LOCAL_ID,
            promptName: MCP_PROMPT,
            staticArguments: JSON.stringify({ topic: 'testMCP' }),
            httpHeadersJson: '{}',
          },
        },
      },
      {
        id: 'mcp-resource',
        type: 'mcp_tool',
        position: { x: 260, y: 480 },
        data: {
          label: 'MCP random resource',
          inputBindings: [],
          outputs: [
            { id: 'text', label: 'Response text' },
            { id: 'result', label: 'Full MCP result JSON' },
            { id: 'ok', label: 'Success' },
          ],
          taskConfig: {
            mcpInvokeKind: 'resource',
            mcpServerId: MCP_LOCAL_ID,
            resourceUri: MCP_RESOURCE_URI,
            httpHeadersJson: '{}',
          },
        },
      },
      {
        id: 'api-basic',
        type: 'api',
        position: { x: 480, y: 160 },
        data: {
          label: 'HTTP Basic auth',
          inputBindings: [
            {
              id: 'url',
              label: 'URL',
              mode: 'static',
              value: 'https://postman-echo.com/get',
            },
            { id: 'body', label: 'Request body', mode: 'static', value: '' },
            { id: 'headers', label: 'Extra headers (JSON)', mode: 'static', value: '{}' },
          ],
          outputs: [
            { id: 'status', label: 'HTTP status' },
            { id: 'body', label: 'Response body' },
            { id: 'ok', label: 'Success (2xx)' },
          ],
          taskConfig: {
            method: 'GET',
            authType: 'none',
            httpHeadersJson: JSON.stringify({ Authorization: 'Basic YWRtaW46cGFzc3dvcmQ=' }),
            timeoutMs: 60000,
          },
        },
      },
      {
        id: 'api-login',
        type: 'api',
        position: { x: 700, y: 160 },
        data: {
          label: 'DummyJSON login',
          inputBindings: [
            {
              id: 'url',
              label: 'URL',
              mode: 'static',
              value: 'https://dummyjson.com/auth/login',
            },
            {
              id: 'body',
              label: 'Request body',
              mode: 'static',
              value: JSON.stringify({ username: 'emilys', password: 'emilyspass' }),
            },
            { id: 'headers', label: 'Extra headers (JSON)', mode: 'static', value: '{}' },
          ],
          outputs: [
            { id: 'status', label: 'HTTP status' },
            { id: 'body', label: 'Response body' },
            { id: 'ok', label: 'Success (2xx)' },
          ],
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 60000 },
        },
      },
      {
        id: 'api-bearer',
        type: 'api',
        position: { x: 920, y: 160 },
        data: {
          label: 'DummyJSON /auth/me',
          inputBindings: [
            {
              id: 'url',
              label: 'URL',
              mode: 'static',
              value: 'https://dummyjson.com/auth/me',
            },
            { id: 'body', label: 'Request body', mode: 'static', value: '' },
            { id: 'headers', label: 'Extra headers (JSON)', mode: 'static', value: '{}' },
          ],
          outputs: [
            { id: 'status', label: 'HTTP status' },
            { id: 'body', label: 'Response body' },
            { id: 'ok', label: 'Success (2xx)' },
          ],
          taskConfig: {
            method: 'GET',
            authType: 'bearer',
            bearerToken: '{{api-login.body.accessToken}}',
            timeoutMs: 60000,
          },
        },
      },
      {
        id: 'api-apikey',
        type: 'api',
        position: { x: 1140, y: 160 },
        data: {
          label: 'HTTPBin API key',
          inputBindings: [
            {
              id: 'url',
              label: 'URL',
              mode: 'static',
              value: 'https://httpbin.org/headers',
            },
            { id: 'body', label: 'Request body', mode: 'static', value: '' },
            { id: 'headers', label: 'Extra headers (JSON)', mode: 'static', value: '{}' },
          ],
          outputs: [
            { id: 'status', label: 'HTTP status' },
            { id: 'body', label: 'Response body' },
            { id: 'ok', label: 'Success (2xx)' },
          ],
          taskConfig: {
            method: 'GET',
            authType: 'api_key',
            apiKeyHeader: 'X-API-Key',
            apiKeyValue: 'MySecretKey123',
            timeoutMs: 60000,
          },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'mcp-symbols' },
      { id: 'e1b', source: 'mcp-symbols', target: 'mcp-prompt' },
      { id: 'e1c', source: 'mcp-prompt', target: 'mcp-resource' },
      { id: 'e2', source: 'mcp-resource', target: 'api-basic' },
      { id: 'e3', source: 'api-basic', target: 'api-login' },
      { id: 'e4', source: 'api-login', target: 'api-bearer' },
      { id: 'e5', source: 'api-bearer', target: 'api-apikey' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function upsertWorkflow(ownerUserId, graph) {
  const actor = { id: 'test-script', name: 'testMCP script', type: 'system' };
  const db = getDb();
  const globalRow = db.prepare('SELECT id, owner_user_id FROM agent_workflow_definitions WHERE id = ?').get(WORKFLOW_ID);
  if (globalRow && globalRow.owner_user_id !== ownerUserId) {
    db.prepare(
      `UPDATE agent_workflow_definitions SET owner_user_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(ownerUserId, WORKFLOW_ID);
    console.log('Reassigned workflow owner:', WORKFLOW_ID, '→', ownerUserId);
  }

  const existing = store.getDefinition(WORKFLOW_ID, ownerUserId);
  const patch = {
    name: 'testMCP',
    description: 'Chat → MCP tool + prompt + resource → Basic / Bearer / API-key API tests',
    graph,
    trigger_modes: ['manual', 'chat'],
    chat_trigger_phrase: CHAT_PHRASE,
    schedule_cron: '',
  };
  if (existing) {
    store.updateDraft(WORKFLOW_ID, ownerUserId, patch, actor);
    console.log('Updated workflow draft:', WORKFLOW_ID, 'for', ownerUserId);
  } else if (globalRow) {
    store.updateDraft(WORKFLOW_ID, ownerUserId, patch, actor);
    console.log('Updated reassigned workflow:', WORKFLOW_ID);
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
    store.appendAudit(WORKFLOW_ID, { action: 'created', summary: 'testMCP script', changedBy: actor.id });
    console.log('Created workflow:', WORKFLOW_ID);
  }
  return store.publishDefinition(WORKFLOW_ID, ownerUserId, actor);
}

function stepOutput(run, nodeId) {
  const step = run.steps?.find((s) => s.node_id === nodeId);
  if (!step?.output) return null;
  return typeof step.output === 'string' ? JSON.parse(step.output) : step.output;
}

async function waitForRun(runId, ownerUserId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId, ownerUserId);
    if (run.status === 'completed' || run.status === 'failed') return run;
    await sleep(500);
  }
  return store.getRun(runId, ownerUserId);
}

async function main() {
  const ceo = getCeoUser();
  console.log('CEO owner:', ceo.id, ceo.name || '');
  const admin = getDb().prepare(`SELECT id, role FROM platform_users WHERE role = 'admin' LIMIT 1`).get();
  if (admin) {
    try {
      await connectMcpServer(MCP_SERVER_ID, { id: admin.id, role: admin.role });
      console.log('MCP server connected:', MCP_SERVER_ID);
    } catch (e) {
      console.warn('MCP connect warning:', e.message);
    }
    try {
      await connectMcpServer(MCP_LOCAL_ID, { id: admin.id, role: admin.role });
      console.log('Local MCP connected:', MCP_LOCAL_ID);
    } catch (e) {
      console.warn('Local MCP connect warning (start local-mcp-random-sse):', e.message);
    }
  }

  const graph = buildTestMcpGraph();
  const published = upsertWorkflow(ceo.id, graph);
  console.log('Published:', published.status, 'nodes:', published.published_graph?.nodes?.length);

  const chatRun = await tryTriggerWorkflowFromChat(ceo.id, `Please run ${CHAT_PHRASE} now`, {
    id: 'test-script',
    name: 'testMCP',
    type: 'system',
  });
  if (!chatRun) throw new Error('Chat trigger did not start workflow — check phrase and publish state');
  console.log('Chat-triggered run #' + chatRun.run_number, 'id=', chatRun.id);

  const finalRun = await waitForRun(chatRun.id, ceo.id);
  console.log('\n--- Run', finalRun.status, 'progress', finalRun.progress_pct + '%');
  if (finalRun.error_message) console.log('Error:', finalRun.error_message);

  for (const step of finalRun.steps || []) {
    console.log(`\n• ${step.node_label} (${step.node_id}) — ${step.status}`);
    if (step.error_message) console.log('  error:', step.error_message);
    const out = stepOutput(finalRun, step.node_id);
    if (out) console.log('  output:', JSON.stringify(out, null, 2).slice(0, 400));
  }

  const mcpOut = stepOutput(finalRun, 'mcp-symbols');
  const mcpPromptOut = stepOutput(finalRun, 'mcp-prompt');
  const mcpResourceOut = stepOutput(finalRun, 'mcp-resource');
  const basicOut = stepOutput(finalRun, 'api-basic');
  const loginOut = stepOutput(finalRun, 'api-login');
  const bearerOut = stepOutput(finalRun, 'api-bearer');
  const keyOut = stepOutput(finalRun, 'api-apikey');

  const checks = [
    ['chat trigger started run', !!chatRun?.id],
    ['run completed', finalRun.status === 'completed'],
    ['MCP step ok', mcpOut?.ok === true || mcpOut?.ok === 'true'],
    ['MCP returned symbols text', String(mcpOut?.text || '').length > 10],
    ['MCP prompt step ok', mcpPromptOut?.ok === true || mcpPromptOut?.ok === 'true'],
    ['MCP prompt has brief text', String(mcpPromptOut?.text || '').includes('MCP prompt brief')],
    ['MCP resource step ok', mcpResourceOut?.ok === true || mcpResourceOut?.ok === 'true'],
    ['MCP resource has summary', String(mcpResourceOut?.text || '').includes('random server')],
    ['Basic auth 200', basicOut?.status === 200 && basicOut?.ok],
    ['Basic auth echoed in headers', JSON.stringify(basicOut?.body || {}).includes('Basic YWRtaW46cGFzc3dvcmQ=')],
    ['Login returned token', !!(loginOut?.body?.accessToken || loginOut?.body?.token)],
    ['Bearer /auth/me 200', bearerOut?.status === 200 && bearerOut?.ok],
    ['Bearer user emilys', bearerOut?.body?.username === 'emilys'],
    ['API key echoed', JSON.stringify(keyOut?.body || {}).includes('MySecretKey123')],
  ];

  console.log('\n--- Assertions ---');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(ok ? '  ✓' : '  ✗', label);
    if (!ok) failed++;
  }

  if (failed) {
    process.exit(1);
  }
  console.log('\nAll testMCP checks passed.');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
