/**
 * Focused E2E: set workflow allowlist to BTC+ETH only, run maker→checker→CEO→place.
 * Usage: node scripts/test-ibkr-crypto-btc-eth-e2e.js
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
} from '../src/services/agent-workflow-runner.js';
import * as store from '../src/services/agent-workflow-store.js';
import {
  seedIbkrMakerCheckerWorkflow,
  WORKFLOW_ID,
} from './seed-ibkr-maker-checker-workflow.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import { IBKR_DAY_PLAN_VARIABLES } from './ibkr-workflow-variables.js';
import { withDerivedAllowlistKeys } from '../src/services/ibkr-workflow-variables.js';

initDb();
const db = getDb();
const ownerUserId = getBalaCeoAuthId();

const CRYPTO_ALLOWLIST = [
  {
    key: 'PAXOS:BTC',
    symbol: 'BTC',
    exchange: 'PAXOS',
    market: 'CRYPTO',
    currency: 'USD',
    board_lot: 0.0001,
    sec_type: 'CRYPTO',
  },
  {
    key: 'PAXOS:ETH',
    symbol: 'ETH',
    exchange: 'PAXOS',
    market: 'CRYPTO',
    currency: 'USD',
    board_lot: 0.001,
    sec_type: 'CRYPTO',
  },
];

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
  console.log('=== IBKR BTC+ETH crypto E2E ===');
  console.log('owner', ownerUserId);
  console.log('OPENAI configured', !!(process.env.OPENAI_API_KEY || process.env.OPENAI_PRIMARY_API_KEY));
  console.log('TRADING_ENABLED', process.env.IBKR_TRADING_ENABLED === '1' || process.env.IBKR_TRADING_ENABLED === 'true');
  console.log('IBKR_PORT set', !!process.env.IBKR_PORT);

  const backend = (process.env.AGENT_OS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const h = await fetch(`${backend}/health`, { signal: AbortSignal.timeout(3000) });
  if (!h.ok) throw new Error(`Backend health ${h.status}`);
  console.log('backend health ok');

  console.log('\n=== Reset day reservations (free budget) ===');
  try {
    const { spawnSync } = await import('child_process');
    spawnSync(process.execPath, [join(__dirname, 'reset-ibkr-day-reservations.js')], {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
      env: process.env,
    });
  } catch (e) {
    console.warn('budget reset skipped:', e.message);
  }

  console.log('\n=== Cancel existing paper open orders ===');
  try {
    const { cancelAllOpenOrders } = await import('../src/services/ibkr-gateway-client.js');
    const cancelled = await cancelAllOpenOrders({
      cancelSource: 'e2e',
      ownerUserId: process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala',
    });
    console.log('cancelled orders', cancelled?.cancelled ?? cancelled);
  } catch (e) {
    console.warn('cancel open orders skipped:', e.message);
  }

  console.log('\n=== Seed / publish with BTC+ETH allowlist ===');
  const { def } = await seedIbkrMakerCheckerWorkflow(ownerUserId, { publish: true });
  const cryptoVars = withDerivedAllowlistKeys({
    ...IBKR_DAY_PLAN_VARIABLES,
    ...(def?.variables || {}),
    markets: ['CRYPTO'],
    allowlist: CRYPTO_ALLOWLIST,
  });
  store.updateDraft(
    WORKFLOW_ID,
    ownerUserId,
    { variables: cryptoVars },
    { id: 'e2e', name: 'E2E crypto' }
  );
  // Re-publish so published snapshot / status stays live
  try {
    store.publishDefinition(WORKFLOW_ID, ownerUserId, { id: 'e2e', name: 'E2E crypto' });
  } catch (e) {
    console.warn('publish note:', e.message);
  }
  store.setPaused(WORKFLOW_ID, ownerUserId, false, { id: 'e2e', name: 'E2E' });

  const updated = store.getDefinition(WORKFLOW_ID, ownerUserId);
  console.log('Workflow:', updated?.id, updated?.status);
  console.log('Allowlist keys:', updated?.variables?.allowlist_keys);
  console.log('Markets:', updated?.variables?.markets);

  if (updated?.status !== 'published') {
    throw new Error('Workflow not published — set Maker OpenAI apiKey on Brain node and re-seed');
  }

  console.log('\n=== Start run (maker chooses BTC and/or ETH) ===');
  const run = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'manual',
    input:
      'Paper day plan: allowlist is ONLY PAXOS:BTC and PAXOS:ETH. Pick 1–2 fractional crypto buys that fit the $1000 budget (respect board_lot). Justify clearly for checker.',
    actor: { id: 'e2e', name: 'E2E Crypto Test' },
  });
  console.log('Run id:', run.id, 'status:', run.status);

  console.log('\n=== Wait maker/checker → CEO (up to 6 min) ===');
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

  let ceoKanban = db
    .prepare(
      `SELECT id, title, status FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');

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

  if (!ceoKanban) {
    console.error('\nNo CEO Kanban — maker/checker may have rejected or validate failed');
    summarizeSteps(store.getRun(run.id, ownerUserId));
    // Dump validate / maker outputs for debug
    for (const id of ['brain-maker', 'api-validate', 'parse-checker', 'api-preflight']) {
      const s = latest?.steps?.find((x) => x.node_id === id);
      if (!s) continue;
      const out = typeof s.output === 'string' ? s.output : JSON.stringify(s.output || {});
      console.log(`\n--- ${id} (${s.status}) ---\n${out.slice(0, 1200)}`);
    }
    process.exit(1);
  }

  console.log('\n=== CEO approve ===', ceoKanban.id, ceoKanban.title);
  await completeCeoApprovalResponse({
    kanbanTaskId: ceoKanban.id,
    decision: 'approve',
    comment: 'E2E approve BTC/ETH paper day plan',
    actor: { id: ownerUserId, name: 'CEO E2E' },
  });

  console.log('\n=== Wait for place / completion ===');
  latest = await waitFor(
    run.id,
    (r) =>
      ['completed', 'failed'].includes(r.status) ||
      r.steps?.some((s) => s.node_id === 'api-place' && s.status === 'completed'),
    { timeoutMs: 180000, label: 'place or complete' }
  );

  console.log('\n=== Final ===');
  console.log('Status:', latest.status);
  summarizeSteps(latest);

  const place = latest.steps?.find((s) => s.node_id === 'api-place');
  if (latest.status === 'failed') {
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
      orders: (body.gateway_results || body.results || []).map((r) => ({
        key: r.key,
        orderIds: r.orderIds,
        ok: r.ok,
        error: r.error,
      })),
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
