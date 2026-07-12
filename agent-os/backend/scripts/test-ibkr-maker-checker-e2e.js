/**
 * E2E: IBKR maker/checker paper workflow.
 * Usage: node scripts/test-ibkr-maker-checker-e2e.js
 *
 * Requires: backend APIs on 3001 (or AGENT_OS_API_URL), OpenAI key, Ollama, Gateway optional
 * (place stays dry-run while IBKR_TRADING_ENABLED=0).
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import {
  startAgentWorkflowRun,
  completeCeoApprovalResponse,
  injectWorkflowStepOutput,
} from '../src/services/agent-workflow-runner.js';
import * as store from '../src/services/agent-workflow-store.js';
import {
  seedIbkrMakerCheckerWorkflow,
  WORKFLOW_ID,
} from './seed-ibkr-maker-checker-workflow.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

initDb();
const db = getDb();
const ownerUserId = getBalaCeoAuthId();

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeSteps(run) {
  for (const s of run.steps || []) {
    const err = s.error_message ? ` err=${s.error_message}` : '';
    console.log(`  ${s.node_id} (${s.node_type}): ${s.status}${err}`);
  }
}

async function waitFor(runId, predicate, { timeoutMs = 300000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId, ownerUserId);
    if (predicate(run)) return run;
    if (['failed', 'completed'].includes(run.status) && !predicate(run)) {
      return run;
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function main() {
  console.log('=== IBKR maker/checker E2E ===');
  console.log('owner', ownerUserId);
  console.log('OPENAI', !!(process.env.OPENAI_API_KEY || process.env.OPENAI_PRIMARY_API_KEY));
  console.log('TRADING_ENABLED', process.env.IBKR_TRADING_ENABLED || '0');
  console.log('IBKR_PORT', process.env.IBKR_PORT || '');

  const backend = (process.env.AGENT_OS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
  try {
    const h = await fetch(`${backend}/health`, { signal: AbortSignal.timeout(3000) });
    console.log('backend health', h.status);
  } catch (e) {
    throw new Error(`Backend not reachable at ${backend}: ${e.message}`);
  }

  console.log('\n=== Cancel existing paper open orders ===');
  try {
    const { cancelAllOpenOrders } = await import('../src/services/ibkr-gateway-client.js');
    const cancelled = await cancelAllOpenOrders({
      cancelSource: 'e2e',
      ownerUserId: process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala',
    });
    console.log('cancelled', cancelled);
  } catch (e) {
    console.warn('cancel open orders skipped:', e.message);
  }

  console.log('\n=== Seed / publish ===');
  const { def } = await seedIbkrMakerCheckerWorkflow(ownerUserId, { publish: true });
  store.setPaused(WORKFLOW_ID, ownerUserId, false, { id: 'e2e', name: 'E2E' });
  console.log('Workflow:', def?.id, def?.status);

  if (def?.status !== 'published') {
    throw new Error('Workflow not published — set Maker OpenAI apiKey on Brain node and re-seed');
  }

  console.log('\n=== Start run ===');
  const run = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'manual',
    input: 'Prepare today paper day plan for allowlist names within $1000 budget.',
    actor: { id: 'e2e', name: 'E2E Test' },
  });
  console.log('Run id:', run.id, 'status:', run.status);

  // Wait until CEO approval appears OR run fails/completes early
  console.log('\n=== Wait maker/checker loop → CEO (up to 5 min) ===');
  let latest;
  try {
    latest = await waitFor(
      run.id,
      (r) => {
        if (r.status === 'failed') return true;
        const ceo = r.steps?.find((s) => s.node_id === 'ceo-day');
        if (ceo && ['in_progress', 'completed', 'listening', 'awaiting'].includes(ceo.status)) return true;
        const kanban = db
          .prepare(
            `SELECT id FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? LIMIT 1`
          )
          .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');
        return !!kanban;
      },
      { timeoutMs: 360000, label: 'CEO approval step' }
    );
  } catch (e) {
    latest = store.getRun(run.id, ownerUserId);
    console.error(e.message);
    summarizeSteps(latest);
    throw e;
  }

  summarizeSteps(latest);
  if (latest.status === 'failed') {
    console.error('\nRun failed before CEO');
    process.exit(1);
  }

  // If checker never approved, try inject path for dry E2E continuity
  const parseStep = latest.steps?.find((s) => s.node_id === 'parse-checker');
  const ifChecker = latest.steps?.find((s) => s.node_id === 'if-checker');
  if (ifChecker?.status === 'completed') {
    const out = typeof ifChecker.output === 'string' ? ifChecker.output : JSON.stringify(ifChecker.output || {});
    console.log('if-checker output', out.slice(0, 200));
  }

  let ceoKanban = db
    .prepare(
      `SELECT id, title, status FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');

  if (!ceoKanban) {
    // Wait a bit more for kanban create
    for (let i = 0; i < 30 && !ceoKanban; i++) {
      await sleep(2000);
      ceoKanban = db
        .prepare(
          `SELECT id, title, status FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? ORDER BY id DESC LIMIT 1`
        )
        .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');
      latest = store.getRun(run.id, ownerUserId);
      if (latest.status === 'failed') break;
    }
  }

  if (!ceoKanban) {
    console.error('\nNo CEO Kanban task — maker/checker may have rejected or API validate failed');
    summarizeSteps(store.getRun(run.id, ownerUserId));
    process.exit(1);
  }

  console.log('\n=== CEO approve ===', ceoKanban.id, ceoKanban.title);
  await completeCeoApprovalResponse({
    kanbanTaskId: ceoKanban.id,
    decision: 'approve',
    comment: 'E2E approve paper day plan',
    actor: { id: ownerUserId, name: 'CEO E2E' },
  });

  console.log('\n=== Wait for place / completion ===');
  latest = await waitFor(
    run.id,
    (r) => ['completed', 'failed'].includes(r.status) || r.steps?.some((s) => s.node_id === 'api-place' && s.status === 'completed'),
    { timeoutMs: 180000, label: 'place or complete' }
  );

  console.log('\n=== Final ===');
  console.log('Status:', latest.status);
  summarizeSteps(latest);

  const place = latest.steps?.find((s) => s.node_id === 'api-place');
  const rejectNote = latest.steps?.find((s) => s.node_id === 'brain-reject' && s.status === 'completed');
  const ok =
    latest.status === 'completed' ||
    place?.status === 'completed' ||
    (latest.status !== 'failed' && place?.status === 'completed');

  if (!ok && latest.status === 'failed') {
    console.error('\nTEST FAILED');
    process.exit(1);
  }
  if (place?.status === 'completed') {
    let placeOut = place.output;
    if (typeof placeOut === 'string') {
      try {
        placeOut = JSON.parse(placeOut);
      } catch {
        /* ignore */
      }
    }
    const body = placeOut?.body || placeOut || {};
    console.log('\nPlace result:', {
      placed: body.placed,
      dry_run: body.dry_run,
      no_trade_day: body.no_trade_day,
      message: body.message,
      orders: (body.gateway_results || []).map((r) => ({ key: r.key, orderIds: r.orderIds, ok: r.ok })),
    });
    console.log('\nTEST PASSED (place step completed)');
    process.exit(0);
  }
  if (latest.status === 'completed') {
    console.log('\nTEST PASSED');
    process.exit(0);
  }
  console.error('\nTEST FAILED — unexpected terminal state');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
