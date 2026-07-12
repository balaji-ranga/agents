/**
 * Test: snapshot exposes prior IB cancel learnings; Maker uses them for BTC/ETH;
 * optional live place records cancel events.
 *
 * Usage: node scripts/test-ibkr-maker-learnings-crypto.js
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
import {
  ensureIbkrOrderEventTables,
  buildOrderLearnings,
  IBKR_ORDER_REASON,
  recordOrderEvent,
  listOrderEvents,
} from '../src/services/ibkr-order-events.js';

initDb();
const db = getDb();
const ownerUserId = getBalaCeoAuthId();
const backend = (process.env.AGENT_OS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

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

const FULL_ALLOWLIST = IBKR_DAY_PLAN_VARIABLES.allowlist;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeSteps(run) {
  for (const s of run.steps || []) {
    const err = s.error_message ? ` err=${s.error_message}` : '';
    console.log(`  ${s.node_id} (${s.node_type}): ${s.status}${err}`);
  }
}

function parseStepOutput(step) {
  if (!step) return null;
  let out = step.output;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      return { text: out };
    }
  }
  return out;
}

async function waitFor(runId, predicate, { timeoutMs = 360000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId, ownerUserId);
    if (predicate(run)) return run;
    if (['failed', 'completed'].includes(run.status) && !predicate(run)) return run;
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${backend}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test': '1',
    },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

function ensureLearningSeeds() {
  ensureIbkrOrderEventTables();
  const learnings = buildOrderLearnings(ownerUserId, { days: 30 });
  const hasPaxosHint = (learnings.avoid_hints || []).some((h) => /PAXOS:(BTC|ETH)/i.test(h));
  if (!hasPaxosHint) {
    for (const key of ['PAXOS:BTC', 'PAXOS:ETH']) {
      recordOrderEvent({
        owner_user_id: ownerUserId,
        symbol_key: key,
        symbol: key.split(':')[1],
        side: 'BUY',
        status: 'Cancelled',
        reason_code: IBKR_ORDER_REASON.IB_SYSTEM_CANCEL,
        reason_text:
          'Margin calculation not supported for this product; Product not available for trading (IB paper/PAXOS)',
        source: 'ib',
      });
    }
  }
  return buildOrderLearnings(ownerUserId, { days: 30 });
}

function extractMakerPlan(run) {
  const maker = run.steps?.find((s) => s.node_id === 'maker-1');
  const out = parseStepOutput(maker);
  const text =
    out?.text ||
    out?.body?.text ||
    out?.message?.content ||
    (typeof out === 'string' ? out : JSON.stringify(out || {}));
  let plan = null;
  try {
    const raw = String(text || '');
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) plan = JSON.parse(body.slice(start, end + 1));
  } catch {
    /* ignore */
  }
  return { maker, text: String(text || ''), plan };
}

function assertMakerInformed(plan, text, learnings) {
  const trades = Array.isArray(plan?.trades) ? plan.trades : [];
  const paxosTrades = trades.filter((t) => /^PAXOS:(BTC|ETH)$/i.test(String(t.key || '')));
  const blob = `${text}\n${JSON.stringify(plan || {})}\n${(plan?.notes || '')}\n${JSON.stringify(plan?.residual || [])}`.toLowerCase();
  const citesLearning =
    /order_learnings|avoid_hint|not available|margin calculation|paper.*paxos|unsupported|prior cancel|system cancel|reconcile/i.test(
      blob
    ) ||
    (learnings.avoid_hints || []).some((h) => blob.includes(String(h).toLowerCase().slice(0, 40)));

  return {
    tradeCount: trades.length,
    paxosTradeCount: paxosTrades.length,
    paxosTrades,
    citesLearning,
    noTradeDay: trades.length === 0,
    informedSkip: trades.length === 0 && citesLearning,
    informedButPlaced: paxosTrades.length > 0 && citesLearning,
    blindPlace: paxosTrades.length > 0 && !citesLearning,
  };
}

async function main() {
  console.log('=== IBKR Maker learnings + BTC/ETH flow ===');
  console.log('owner', ownerUserId);
  console.log('TRADING_ENABLED', process.env.IBKR_TRADING_ENABLED);
  console.log('OPENAI', !!(process.env.OPENAI_API_KEY || process.env.OPENAI_PRIMARY_API_KEY));

  const health = await fetch(`${backend}/health`, { signal: AbortSignal.timeout(4000) });
  if (!health.ok) throw new Error(`Backend not healthy: ${health.status}`);
  console.log('backend ok');

  console.log('\n=== 1) Ensure prior cancel learnings ===');
  const learnings = ensureLearningSeeds();
  console.log('avoid_hints:', learnings.avoid_hints);
  console.log('cancel_or_reject_count:', learnings.cancel_or_reject_count);
  if (!(learnings.avoid_hints || []).some((h) => /PAXOS/i.test(h))) {
    throw new Error('Expected PAXOS avoid_hints before maker run');
  }

  console.log('\n=== 2) Snapshot must inject order_learnings ===');
  const snap = await api('/api/ibkr-trading/account-snapshot', {
    method: 'POST',
    body: {
      owner_user_id: ownerUserId,
      allowlist: CRYPTO_ALLOWLIST,
      allowlist_keys: ['PAXOS:BTC', 'PAXOS:ETH'],
      daily_budget_usd: 1000,
      require_live_cash: true,
    },
  });
  if (!snap.ok) {
    console.error(snap.json);
    throw new Error(`account-snapshot failed: ${snap.status}`);
  }
  const snapHints = snap.json?.order_learnings?.avoid_hints || [];
  console.log('snapshot.order_learnings.avoid_hints:', snapHints);
  if (!snapHints.some((h) => /PAXOS/i.test(h))) {
    throw new Error('Snapshot missing PAXOS avoid_hints — maker would be blind');
  }
  console.log('reconcile:', snap.json?.reconcile);

  console.log('\n=== 3) Reset budget + seed crypto-only workflow ===');
  try {
    const { spawnSync } = await import('child_process');
    spawnSync(process.execPath, [join(__dirname, 'reset-ibkr-day-reservations.js')], {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
      env: process.env,
    });
  } catch (e) {
    console.warn('budget reset:', e.message);
  }

  const { def } = await seedIbkrMakerCheckerWorkflow(ownerUserId, { publish: true });
  const cryptoVars = withDerivedAllowlistKeys({
    ...IBKR_DAY_PLAN_VARIABLES,
    ...(def?.variables || {}),
    markets: ['CRYPTO'],
    allowlist: CRYPTO_ALLOWLIST,
  });
  store.updateDraft(WORKFLOW_ID, ownerUserId, { variables: cryptoVars }, { id: 'e2e', name: 'E2E' });
  try {
    store.publishDefinition(WORKFLOW_ID, ownerUserId, { id: 'e2e', name: 'E2E' });
  } catch (e) {
    console.warn('publish:', e.message);
  }
  store.setPaused(WORKFLOW_ID, ownerUserId, false, { id: 'e2e', name: 'E2E' });

  console.log('\n=== 4) Start day-plan (Maker must respect order_learnings) ===');
  const run = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'manual',
    input:
      'Paper day plan. Allowlist is only PAXOS:BTC and PAXOS:ETH, BUT you MUST honor snapshot.order_learnings.avoid_hints from prior IB system cancels (margin / product not available on paper). Prefer an empty trades[] day with residual/notes explaining the skip over repeating a known-failing paper crypto place. If you still place, explicitly acknowledge the prior cancel risk in notes.',
    actor: { id: 'e2e', name: 'E2E Learnings' },
  });
  console.log('Run id:', run.id);

  // Wait until maker has produced at least one completed plan
  let latest = await waitFor(
    run.id,
    (r) =>
      r.status === 'failed' ||
      r.steps?.some((s) => s.node_id === 'maker-1' && s.status === 'completed'),
    { timeoutMs: 240000, label: 'first maker completion' }
  );

  // Then wait for checker loop exit → CEO or reject note
  latest = await waitFor(
    run.id,
    (r) => {
      if (['failed', 'completed'].includes(r.status)) return true;
      const ceo = r.steps?.find((s) => s.node_id === 'ceo-day');
      if (ceo && ['in_progress', 'completed', 'listening', 'awaiting'].includes(ceo.status)) return true;
      if (r.steps?.some((s) => s.node_id === 'brain-reject' && s.status === 'completed')) return true;
      if (r.steps?.some((s) => s.node_id === 'api-place' && ['completed', 'failed'].includes(s.status))) {
        return true;
      }
      const kanban = db
        .prepare(
          `SELECT id FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? LIMIT 1`
        )
        .get(`%agent_wf_run_id: ${r.id}%`, '%node_type: ceo_approval%');
      return !!kanban;
    },
    { timeoutMs: 420000, label: 'CEO / reject / complete after maker' }
  );

  console.log('\n=== Maker/checker state ===');
  console.log('Status:', latest.status);
  summarizeSteps(latest);

  const { plan, text } = extractMakerPlan(latest);
  console.log('\nMaker plan trades:', plan?.trades?.length ?? 'n/a');
  console.log('Maker notes:', plan?.notes || '(none)');
  console.log('Maker residual:', JSON.stringify(plan?.residual || []).slice(0, 500));

  const verdict = assertMakerInformed(plan, text, learnings);
  console.log('\nMaker awareness verdict:', verdict);

  if (verdict.blindPlace) {
    console.error('FAIL: Maker placed PAXOS without citing prior system cancels / learnings');
    process.exit(1);
  }
  if (!verdict.citesLearning && !verdict.noTradeDay) {
    console.error('FAIL: Maker neither skipped nor cited order_learnings');
    process.exit(1);
  }
  console.log(
    verdict.informedSkip
      ? 'PASS: Maker skipped crypto citing prior cancels'
      : verdict.informedButPlaced
        ? 'WARN/PASS: Maker placed but acknowledged prior cancel risk'
        : verdict.noTradeDay
          ? 'PASS: empty day (check notes for learning cite)'
          : 'PASS: learning-aware'
  );

  // If CEO pending and maker skipped (empty), approve may still validate empty place
  let ceoKanban = db
    .prepare(
      `SELECT id, title, status FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');

  if (ceoKanban) {
    console.log('\n=== CEO approve empty/aware plan ===', ceoKanban.id);
    await completeCeoApprovalResponse({
      kanbanTaskId: ceoKanban.id,
      decision: 'approve',
      comment: 'E2E approve learning-aware plan',
      actor: { id: ownerUserId, name: 'CEO E2E' },
    });
    latest = await waitFor(
      run.id,
      (r) => ['completed', 'failed'].includes(r.status),
      { timeoutMs: 180000, label: 'run complete' }
    );
    console.log('Post-CEO status:', latest.status);
    summarizeSteps(latest);
  }

  console.log('\n=== 5) Direct place BTC+ETH to exercise cancel capture ===');
  const eventsBefore = listOrderEvents(ownerUserId, { days: 1, limit: 50 }).length;
  // Fresh refs from snapshot
  const refBtc = snap.json?.reference_prices?.['PAXOS:BTC']?.reference_price || 65000;
  const refEth = snap.json?.reference_prices?.['PAXOS:ETH']?.reference_price || 1800;
  const placeBody = {
    owner_user_id: ownerUserId,
    source: 'dayplan',
    cancel_source: 'dayplan',
    allowlist: CRYPTO_ALLOWLIST,
    allowlist_keys: ['PAXOS:BTC', 'PAXOS:ETH'],
    daily_budget_usd: 1000,
    trades_to_place: [
      {
        key: 'PAXOS:BTC',
        symbol: 'BTC',
        exchange: 'PAXOS',
        market: 'CRYPTO',
        currency: 'USD',
        secType: 'CRYPTO',
        side: 'BUY',
        qty: 0.001,
        reference_price: refBtc,
        entry_price: refBtc,
        stop_pct: 1.8,
        tp_pct: 1.2,
        notional_usd: Number((0.001 * refBtc).toFixed(2)),
        thesis: 'E2E cancel-capture place',
        catalysts: 'n/a',
        risks: 'paper crypto unsupported',
        why_now: 'exercise place watch + order_events',
        rationale:
          'Intentional small BTC paper place to verify post-ack cancel capture and order_events logging after prior system cancels.',
      },
      {
        key: 'PAXOS:ETH',
        symbol: 'ETH',
        exchange: 'PAXOS',
        market: 'CRYPTO',
        currency: 'USD',
        secType: 'CRYPTO',
        side: 'BUY',
        qty: 0.01,
        reference_price: refEth,
        entry_price: refEth,
        stop_pct: 1.8,
        tp_pct: 1.2,
        notional_usd: Number((0.01 * refEth).toFixed(2)),
        thesis: 'E2E cancel-capture place',
        catalysts: 'n/a',
        risks: 'paper crypto unsupported',
        why_now: 'exercise place watch + order_events',
        rationale:
          'Intentional small ETH paper place to verify post-ack cancel capture and order_events logging after prior system cancels.',
      },
    ],
  };

  const placed = await api('/api/ibkr-trading/place', { method: 'POST', body: placeBody });
  console.log('place HTTP', placed.status, {
    ok: placed.json?.ok,
    placed: placed.json?.placed,
    message: placed.json?.message,
    error: placed.json?.error,
    results: (placed.json?.gateway_results || []).map((r) => ({
      key: r.key,
      ok: r.ok,
      orderIds: r.orderIds,
      terminal_status: r.terminal_status,
      terminal_cancelled: r.terminal_cancelled,
      terminal_reason_text: r.terminal_reason_text,
      error: r.error,
    })),
  });

  // Reconcile after place (grace may keep reserved briefly)
  await sleep(3000);
  const recon = await api('/api/ibkr-trading/reconcile-orders', {
    method: 'POST',
    body: { owner_user_id: ownerUserId, grace_sec: 0, allowlist: CRYPTO_ALLOWLIST },
  });
  console.log('reconcile after place:', {
    ok: recon.json?.ok,
    released: recon.json?.reconcile?.released,
    filled: recon.json?.reconcile?.filled,
    actions: recon.json?.reconcile?.actions,
  });

  const eventsAfter = listOrderEvents(ownerUserId, { days: 1, limit: 80 });
  const newEvents = eventsAfter.slice(0, Math.max(0, eventsAfter.length - eventsBefore));
  const placeRelated = eventsAfter.filter(
    (e) =>
      /^PAXOS:(BTC|ETH)$/i.test(e.symbol_key || '') &&
      ['place', 'place_watch', 'reconcile', 'ib'].includes(String(e.source || ''))
  );
  console.log(
    '\nRecent PAXOS events:',
    placeRelated.slice(0, 12).map((e) => ({
      symbol_key: e.symbol_key,
      status: e.status,
      reason_code: e.reason_code,
      source: e.source,
      reason_text: String(e.reason_text || '').slice(0, 100),
    }))
  );

  const learningsAfter = buildOrderLearnings(ownerUserId);
  console.log('\nLearnings after place:', learningsAfter.avoid_hints.slice(0, 6));

  console.log('\n=== 6) Restore full allowlist ===');
  const fullVars = withDerivedAllowlistKeys({
    ...IBKR_DAY_PLAN_VARIABLES,
    allowlist: FULL_ALLOWLIST,
  });
  store.updateDraft(WORKFLOW_ID, ownerUserId, { variables: fullVars }, { id: 'e2e', name: 'E2E restore' });
  try {
    store.publishDefinition(WORKFLOW_ID, ownerUserId, { id: 'e2e', name: 'E2E restore' });
  } catch (e) {
    console.warn('restore publish:', e.message);
  }

  const makerPass = verdict.citesLearning || verdict.informedSkip || verdict.noTradeDay;
  const placeLogged = placeRelated.length > 0 || placed.json?.placed === true || placed.json?.ok === false;
  if (!makerPass) {
    console.error('\nTEST FAILED — maker not learning-aware');
    process.exit(1);
  }
  console.log('\nTEST PASSED — maker learning-aware; place/reconcile path exercised');
  console.log({ makerPass, placeLogged, newEventCount: newEvents.length, placeRelated: placeRelated.length });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
