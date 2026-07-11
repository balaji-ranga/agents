/**
 * E2E: SSE workflows — event hook + long-running listen → IF → Parallel → Sub-workflow.
 *
 * Prerequisites:
 *   node tools/local-mcp-random-sse/server.js
 *
 * Run: node backend/scripts/test-sse-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import { startAgentWorkflowRun, stopSseListen } from '../src/services/agent-workflow-runner.js';
import { connectMcpServer, callMcpServerTool } from '../src/services/mcp-servers.js';
import { triggerWorkflowFromHook } from '../src/services/agent-workflow-webhooks.js';
import { ensureWebhookSecret } from '../src/services/agent-workflow-store.js';

initDb();

export const MCP_ID = 'mcp-local-random-sse';
export const EVENT_WF_ID = 'test-sse-event';
export const PARENT_WF_ID = 'test-sse-parent';
export const ODD_WF_ID = 'test-sse-odd';
export const EVEN_WF_ID = 'test-sse-even';

const MCP_BASE = process.env.MCP_RANDOM_URL?.replace(/\/mcp$/, '') || 'http://127.0.0.1:3099';

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
  if (!row) throw new Error('No CEO user');
  return { id: row.id, role: row.role, name: row.name };
}

function apiNode(id, label, x, y, body = '') {
  return {
    id,
    type: 'api',
    position: { x, y },
    data: {
      label,
      inputBindings: [
        { id: 'url', label: 'URL', mode: 'static', value: 'https://postman-echo.com/post' },
        { id: 'body', label: 'Body', mode: 'static', value: body },
        { id: 'headers', label: 'Headers', mode: 'static', value: '{}' },
      ],
      outputs: [
        { id: 'status', label: 'HTTP status' },
        { id: 'body', label: 'Response body' },
        { id: 'ok', label: 'Success' },
      ],
      taskConfig: { method: 'POST', authType: 'none', timeoutMs: 30000 },
    },
  };
}

function subWorkflowNode(id, label, x, y, targetId) {
  return {
    id,
    type: 'sub_workflow',
    position: { x, y },
    data: {
      label,
      taskConfig: {
        targetWorkflowId: targetId,
        triggerMode: 'manual',
        inputTemplate: '{{event}}',
        waitForCompletion: true,
      },
      outputs: [
        { id: 'run_id', label: 'Child run ID' },
        { id: 'status', label: 'Child status' },
        { id: 'text', label: 'Summary' },
      ],
    },
  };
}

function triggerNode(modes) {
  return {
    id: 'trigger-1',
    type: 'trigger',
    position: { x: 40, y: 200 },
    data: {
      label: 'Start',
      triggerModes: modes,
      scheduleCron: '',
      chatPhrase: '',
      inputBindings: [],
      outputs: [{ id: 'trigger_input', label: 'Trigger payload' }],
    },
  };
}

export function buildEventWorkflowGraph() {
  return {
    nodes: [
      triggerNode(['event']),
      apiNode('api-echo', 'Echo event payload', 280, 200, '{{trigger-1.trigger_input}}'),
    ],
    edges: [{ id: 'e1', source: 'trigger-1', target: 'api-echo' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function buildChildWorkflowGraph(id, label) {
  return {
    nodes: [
      triggerNode(['manual']),
      apiNode('api-tag', label, 280, 200, JSON.stringify({ workflow: id, label })),
    ],
    edges: [{ id: 'e1', source: 'trigger-1', target: 'api-tag' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function buildParentWorkflowGraph() {
  return {
    nodes: [
      triggerNode(['manual']),
      {
        id: 'listen-1',
        type: 'sse_listen',
        position: { x: 220, y: 200 },
        data: {
          label: 'SSE listen',
          taskConfig: {
            mcpServerId: MCP_ID,
            eventsPath: '/events/stream',
            httpHeadersJson: '{}',
          },
          outputs: [
            { id: 'event', label: 'Latest event' },
            { id: 'parity', label: 'parity from event' },
            { id: 'event_count', label: 'Count' },
          ],
        },
      },
      {
        id: 'if-parity',
        type: 'if',
        position: { x: 420, y: 200 },
        data: {
          label: 'Odd?',
          taskConfig: {
            sourceNodeId: 'listen-1',
            sourceOutputKey: 'parity',
            operator: 'eq',
            compareValue: 'odd',
          },
        },
      },
      {
        id: 'parallel-odd',
        type: 'parallel',
        position: { x: 620, y: 80 },
        data: { label: 'Parallel odd branch' },
      },
      {
        id: 'parallel-even',
        type: 'parallel',
        position: { x: 620, y: 320 },
        data: { label: 'Parallel even branch' },
      },
      apiNode('api-odd', 'Echo odd', 820, 40, '{"branch":"odd","parity":"{{listen-1.parity}}"}'),
      subWorkflowNode('sub-odd', 'Invoke odd WF', 820, 120, ODD_WF_ID),
      apiNode('api-even', 'Echo even', 820, 280, '{"branch":"even","parity":"{{listen-1.parity}}"}'),
      subWorkflowNode('sub-even', 'Invoke even WF', 820, 360, EVEN_WF_ID),
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'listen-1' },
      { id: 'e2', source: 'listen-1', target: 'if-parity' },
      { id: 'e3', source: 'if-parity', target: 'parallel-odd', sourceHandle: 'true' },
      { id: 'e4', source: 'if-parity', target: 'parallel-even', sourceHandle: 'false' },
      { id: 'e5', source: 'parallel-odd', target: 'api-odd' },
      { id: 'e6', source: 'parallel-odd', target: 'sub-odd' },
      { id: 'e7', source: 'parallel-even', target: 'api-even' },
      { id: 'e8', source: 'parallel-even', target: 'sub-even' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function upsertWorkflow(id, ownerUserId, patch, graph) {
  const actor = { id: 'sse-test', name: 'SSE test script', type: 'system' };
  const existing = store.getDefinition(id, ownerUserId);
  const full = {
    name: patch.name,
    description: patch.description,
    graph,
    trigger_modes: patch.trigger_modes,
    schedule_cron: '',
    chat_trigger_phrase: '',
  };
  if (existing) {
    store.updateDraft(id, ownerUserId, full, actor);
  } else {
    getDb()
      .prepare(
        `INSERT INTO agent_workflow_definitions (id, name, description, owner_user_id, draft_graph_json, status, trigger_modes)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)`
      )
      .run(id, full.name, full.description, ownerUserId, JSON.stringify(graph), full.trigger_modes.join(','));
    store.appendAudit(id, { action: 'created', summary: patch.name, changedBy: actor.id });
  }
  return store.publishDefinition(id, ownerUserId, actor);
}

async function waitForRun(runId, ownerUserId, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId, ownerUserId);
    if (run.status === 'completed' || run.status === 'failed') return run;
    await sleep(400);
  }
  return store.getRun(runId, ownerUserId);
}

function stepOutput(run, nodeId) {
  const step = run.steps?.find((s) => s.node_id === nodeId);
  if (!step?.output) return null;
  return typeof step.output === 'string' ? JSON.parse(step.output) : step.output;
}

function stepStatus(run, nodeId) {
  return run.steps?.find((s) => s.node_id === nodeId)?.status;
}

async function ensureMcpServer(admin) {
  const health = await fetch(`${MCP_BASE}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`Local MCP not running at ${MCP_BASE} — start: node tools/local-mcp-random-sse/server.js`);
  }
  const row = getDb().prepare('SELECT id FROM mcp_servers WHERE id = ?').get(MCP_ID);
  if (!row) {
    console.log('Run: node backend/scripts/seed-local-mcp-random-sse.js');
    throw new Error(`MCP ${MCP_ID} not in registry`);
  }
  await connectMcpServer(MCP_ID, admin);
}

async function main() {
  const ceo = getCeoUser();
  const admin = getDb().prepare(`SELECT id, role FROM platform_users WHERE role = 'admin' LIMIT 1`).get();
  console.log('CEO:', ceo.id);

  await ensureMcpServer(admin);

  upsertWorkflow(ODD_WF_ID, ceo.id, { name: 'testSSE odd child', description: 'Odd branch child', trigger_modes: ['manual'] }, buildChildWorkflowGraph(ODD_WF_ID, 'odd'));
  upsertWorkflow(EVEN_WF_ID, ceo.id, { name: 'testSSE even child', description: 'Even branch child', trigger_modes: ['manual'] }, buildChildWorkflowGraph(EVEN_WF_ID, 'even'));
  upsertWorkflow(EVENT_WF_ID, ceo.id, { name: 'testSSE event', description: 'Event hook → API echo', trigger_modes: ['event'] }, buildEventWorkflowGraph());
  upsertWorkflow(PARENT_WF_ID, ceo.id, { name: 'testSSE parent', description: 'Listen → IF → Parallel → Sub-workflow', trigger_modes: ['manual'] }, buildParentWorkflowGraph());
  console.log('Published workflows');

  ensureWebhookSecret(EVENT_WF_ID);
  const hookRun = await triggerWorkflowFromHook(EVENT_WF_ID, { type: 'test', value: 42, parity: 'even' });
  const hookFinal = await waitForRun(hookRun.id, ceo.id);
  console.log('Hook run', hookFinal.status);

  const parentRun = await startAgentWorkflowRun(PARENT_WF_ID, ceo.id, { trigger: 'manual', input: 'parent test' });
  console.log('Parent run #' + parentRun.run_number);
  await sleep(1000);

  await callMcpServerTool(MCP_ID, 'emit_random_event', {}, admin);
  await sleep(3000);

  let mid = store.getRun(parentRun.id, ceo.id);
  const listenMid = stepOutput(mid, 'listen-1');
  const listenStatusMid = stepStatus(mid, 'listen-1');
  const subStep = (mid.steps || []).find((s) => s.node_id === 'sub-odd' || s.node_id === 'sub-even');

  await stopSseListen(parentRun.id, 'listen-1', ceo.id);
  const parentFinal = await waitForRun(parentRun.id, ceo.id, 30000);

  const checks = [
    ['event hook completed', hookFinal.status === 'completed'],
    ['parent listen was active', listenStatusMid === 'listening'],
    ['event received while listening', (listenMid?.event_count || 0) >= 1],
    ['IF branch executed (sub or api step)', !!subStep?.status && subStep.status === 'completed'],
    ['listen stopped and run finished', parentFinal.status === 'completed'],
  ];

  console.log('\n--- Assertions ---');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(ok ? '  ✓' : '  ✗', label);
    if (!ok) failed++;
  }
  console.log('\nListen mid:', JSON.stringify(listenMid, null, 2));
  console.log('Branch step:', subStep?.node_id, subStep?.status);
  if (failed) process.exit(1);
  console.log('\nAll SSE workflow checks passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
