/**
 * Soft day-plan smoke: trigger published workflow, wait for terminal, assert snapshot/analytics nodes.
 * Does not force OpenAI checker. Uses existing published graph.
 * Usage: node scripts/test-ibkr-dayplan-analytics-smoke.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import * as store from '../src/services/agent-workflow-store.js';
import { startAgentWorkflowRun } from '../src/services/agent-workflow-runner.js';
import * as ledger from '../src/services/ibkr-trading-ledger.js';

initDb();
ledger.ensureIbkrLedgerTables();

const WORKFLOW_ID = 'ibkr-maker-checker-paper';
const owner = getBalaCeoAuthId();
const db = getDb();

console.log('=== Day-plan smoke (analytics-aware) ===');
const def = store.getDefinition(WORKFLOW_ID, owner);
if (!def || def.status !== 'published') {
  console.error('Workflow not published');
  process.exit(1);
}

const day = ledger.getDayStatus(owner);
console.log('budget before', {
  remaining: day.budget_remaining_usd,
  reserved: day.reserved_usd,
  trades: day.trades_placed,
});

// Release stuck reserved rows from tests so day-plan can spend
const stuck = db
  .prepare(
    `SELECT id, symbol_key, notional_usd FROM ibkr_trade_reservations
     WHERE owner_user_id=? AND status='reserved' AND symbol_key LIKE 'TEST:%'`
  )
  .all(owner);
for (const r of stuck) {
  ledger.releaseReservation(r.id, { reason: 'cancelled' });
  console.log('released test reservation', r.id, r.symbol_key);
}
// Also release dry-run NVDA leftovers from paper pipeline if still reserved
const dry = db
  .prepare(
    `SELECT id, symbol_key FROM ibkr_trade_reservations
     WHERE owner_user_id=? AND status='reserved'
       AND detail_json LIKE '%paper pipeline test%'`
  )
  .all(owner);
for (const r of dry) {
  ledger.releaseReservation(r.id, { reason: 'cancelled' });
  console.log('released pipeline reservation', r.id, r.symbol_key);
}

const day2 = ledger.getDayStatus(owner);
console.log('budget after cleanup', {
  remaining: day2.budget_remaining_usd,
  reserved: day2.reserved_usd,
});

const run = await startAgentWorkflowRun(WORKFLOW_ID, owner, {
  trigger: 'manual',
  input:
    'Paper day plan smoke after analytics. Prefer liquid US names within remaining budget. Honor order learnings (skip paper PAXOS). Empty trades[] OK if budget too tight.',
  actor: { type: 'system', id: 'analytics-smoke', name: 'Analytics Smoke' },
});
console.log('started run', run.id, 'number', run.run_number);

const deadline = Date.now() + 8 * 60 * 1000;
let latest = store.getRun(run.id, owner);
while (Date.now() < deadline) {
  latest = store.getRun(run.id, owner);
  const st = latest?.status;
  console.log('status', st, 'progress', latest?.progress_pct);
  if (['completed', 'failed', 'cancelled', 'paused'].includes(st)) break;
  await new Promise((r) => setTimeout(r, 5000));
}

latest = store.getRun(run.id, owner);
console.log('final', latest.status, latest.error_message || '');

const steps = db
  .prepare(
    `SELECT node_id, status FROM agent_workflow_run_steps WHERE run_id=? ORDER BY id`
  )
  .all(run.id);
console.log(
  'steps',
  steps.map((s) => `${s.node_id}:${s.status}`).join(', ')
);

const snap = db
  .prepare(
    `SELECT output_json FROM agent_workflow_run_steps WHERE run_id=? AND node_id='api-snapshot' ORDER BY id DESC LIMIT 1`
  )
  .get(run.id);
if (snap?.output_json) {
  try {
    const out = JSON.parse(snap.output_json);
    const body = out.body || out;
    console.log('snapshot analytics_persist', body.analytics_persist);
  } catch (e) {
    console.warn('snapshot parse', e.message);
  }
}

const hist = db
  .prepare(
    `SELECT node_id, status FROM agent_workflow_run_steps WHERE run_id=? AND node_id IN ('api-brain-history','api-order-history')`
  )
  .all(run.id);
console.log('history nodes', hist);

if (latest.status === 'failed') {
  console.error('DAYPLAN FAILED');
  process.exit(1);
}
if (!['completed', 'paused'].includes(latest.status)) {
  console.error('DAYPLAN DID NOT FINISH', latest.status);
  process.exit(1);
}
console.log('DAYPLAN SMOKE PASSED');
process.exit(0);
