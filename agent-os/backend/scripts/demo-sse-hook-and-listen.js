/**
 * Demo: (1) event hook URL + POST trigger, (2) persistent mid-workflow SSE listen.
 *
 * Part 2 leaves listen RUNNING — stop manually from Workflows UI.
 *
 * Prerequisites:
 *   node tools/local-mcp-random-sse/server.js
 *
 * Optional MCP bridge (SSE → webhook):
 *   WORKFLOW_HOOK_URL=http://127.0.0.1:3001/api/agent-workflows/hooks/test-sse-event
 *   WORKFLOW_HOOK_SECRET=<secret printed below>
 *
 * Run: node backend/scripts/demo-sse-hook-and-listen.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import { startAgentWorkflowRun } from '../src/services/agent-workflow-runner.js';
import { connectMcpServer, callMcpServerTool } from '../src/services/mcp-servers.js';
import { getHookInfo, hookUrlForDefinition, triggerWorkflowFromHook } from '../src/services/agent-workflow-webhooks.js';
import {
  buildEventWorkflowGraph,
  buildParentWorkflowGraph,
  buildChildWorkflowGraph,
  EVENT_WF_ID,
  PARENT_WF_ID,
  ODD_WF_ID,
  EVEN_WF_ID,
  MCP_ID,
} from './test-sse-workflow.js';

initDb();

const PORT = Number(process.env.PORT || 3001);
const BASE =
  process.env.AGENT_OS_BASE_URL ||
  process.env.AGENT_OS_PUBLIC_URL ||
  process.env.PUBLIC_URL ||
  `http://127.0.0.1:${PORT}`;

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

function upsertWorkflow(id, ownerUserId, patch, graph) {
  const actor = { id: 'sse-demo', name: 'SSE demo', type: 'system' };
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
  }
  return store.publishDefinition(id, ownerUserId, actor);
}

async function ensureMcp(admin) {
  const health = await fetch('http://127.0.0.1:3099/health').catch(() => null);
  if (!health?.ok) {
    throw new Error('Local MCP not running — start: node tools/local-mcp-random-sse/server.js');
  }
  await connectMcpServer(MCP_ID, admin);
}

function stepSnapshot(run) {
  const listen = run.steps?.find((s) => s.node_id === 'listen-1');
  const branch = run.steps?.find((s) => s.node_id === 'sub-odd' || s.node_id === 'sub-even');
  let listenOut = null;
  try {
    listenOut = listen?.output ? (typeof listen.output === 'string' ? JSON.parse(listen.output) : listen.output) : null;
  } catch (_) {}
  return {
    run_status: run.status,
    run_number: run.run_number,
    listen_status: listen?.status,
    event_count: listenOut?.event_count ?? listenOut?.outputs?.find((o) => o.id === 'event_count')?.value,
    last_parity: listenOut?.parity ?? listenOut?.outputs?.find((o) => o.id === 'parity')?.value,
    branch_node: branch?.node_id,
    branch_status: branch?.status,
  };
}

async function main() {
  const ceo = getCeoUser();
  const admin = getDb().prepare(`SELECT id, role FROM platform_users WHERE role = 'admin' LIMIT 1`).get();
  await ensureMcp(admin);

  upsertWorkflow(ODD_WF_ID, ceo.id, { name: 'testSSE odd child', description: '', trigger_modes: ['manual'] }, buildChildWorkflowGraph(ODD_WF_ID, 'odd'));
  upsertWorkflow(EVEN_WF_ID, ceo.id, { name: 'testSSE even child', description: '', trigger_modes: ['manual'] }, buildChildWorkflowGraph(EVEN_WF_ID, 'even'));
  upsertWorkflow(EVENT_WF_ID, ceo.id, { name: 'testSSE event', description: '', trigger_modes: ['event'] }, buildEventWorkflowGraph());
  upsertWorkflow(PARENT_WF_ID, ceo.id, { name: 'testSSE parent', description: '', trigger_modes: ['manual'] }, buildParentWorkflowGraph());

  console.log('\n=== 1) Event hook URL (Start node → event mode) ===\n');
  console.log('Base URL source: AGENT_OS_BASE_URL || AGENT_OS_PUBLIC_URL || PUBLIC_URL || http://127.0.0.1:PORT');
  console.log('Resolved base:', BASE.replace(/\/$/, ''));
  console.log('');

  const hookInfo = getHookInfo(EVENT_WF_ID, ceo.id);
  const programmaticUrl = hookUrlForDefinition(EVENT_WF_ID);
  console.log('Hook URL (from getHookInfo — same as UI on Start node when event is checked):');
  console.log(' ', hookInfo.hook_url);
  console.log('Programmatic hookUrlForDefinition():', programmaticUrl);
  console.log('Secret (X-Workflow-Hook-Secret):', hookInfo.webhook_secret);
  console.log('');
  console.log('Note: MCP server does NOT auto-receive this URL. To bridge SSE→hook, start MCP with:');
  console.log(`  WORKFLOW_HOOK_URL=${hookInfo.hook_url}`);
  console.log(`  WORKFLOW_HOOK_SECRET=${hookInfo.webhook_secret}`);
  console.log('  node tools/local-mcp-random-sse/server.js');
  console.log('');

  console.log('--- Firing hook POST (simulates external caller / MCP WORKFLOW_HOOK_URL) ---');
  const hookRun = await triggerWorkflowFromHook(EVENT_WF_ID, { demo: 'hook-test', value: 7, parity: 'odd' });
  await sleep(1500);
  const hookFinal = store.getRun(hookRun.id, ceo.id);
  console.log(`Hook run #${hookFinal.run_number} status: ${hookFinal.status}`);
  const apiStep = hookFinal.steps?.find((s) => s.node_id === 'api-echo');
  console.log(`  api-echo step: ${apiStep?.status}`);

  console.log('\n=== 2) Persistent SSE Listen (test-sse-parent) — NOT auto-stopped ===\n');
  const parentRun = await startAgentWorkflowRun(PARENT_WF_ID, ceo.id, {
    trigger: 'manual',
    input: 'demo persistent listen',
  });
  console.log(`Started parent run #${parentRun.run_number} (id=${parentRun.id})`);
  await sleep(1200);

  let snap0 = stepSnapshot(store.getRun(parentRun.id, ceo.id));
  console.log('After start:', JSON.stringify(snap0, null, 2));

  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- Emit SSE event ${i}/3 via MCP emit_random_event ---`);
    const emitted = await callMcpServerTool(MCP_ID, 'emit_random_event', {}, admin);
    const text = emitted?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    console.log('  MCP emitted:', parsed?.emitted?.parity, 'value=', parsed?.emitted?.value);
    await sleep(2500);
    const snap = stepSnapshot(store.getRun(parentRun.id, ceo.id));
    console.log('  Run snapshot:', JSON.stringify(snap, null, 2));
  }

  const final = store.getRun(parentRun.id, ceo.id);
  console.log('\n=== Result ===');
  console.log(`Run #${final.run_number} should still be RUNNING with listen-1 LISTENING.`);
  console.log(`Open UI: Workflows → run #${final.run_number} → use "Stop listen" when done.`);
  console.log(`Direct: POST /api/agent-workflows/runs/${final.id}/listen/listen-1/stop`);
  console.log('');
  console.log('If MCP has MCP_AUTO_EMIT_MS=5000 (default), events will keep arriving while listen is active.');
  console.log('Each event re-runs IF → Parallel → sub-workflow branch in the SAME run.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
