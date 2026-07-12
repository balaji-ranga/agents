/**
 * Paper pipeline test (no live orders): preflight → validate → dry-run place → day-status.
 * Usage: node scripts/test-ibkr-paper-pipeline.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import * as ledger from '../src/services/ibkr-trading-ledger.js';
import { getIbkrTradingConfig } from '../src/services/ibkr-trading-rules.js';
import { IBKR_DAY_PLAN_VARIABLES } from './ibkr-workflow-variables.js';
import { resolveIbkrPolicy } from '../src/services/ibkr-workflow-variables.js';

initDb();
ledger.ensureIbkrLedgerTables();

const owner = getBalaCeoAuthId();
const cfg = getIbkrTradingConfig();
const policy = resolveIbkrPolicy(IBKR_DAY_PLAN_VARIABLES);

const samplePlan = {
  trades: [
    {
      key: 'NASDAQ:NVDA',
      side: 'BUY',
      qty: 1,
      reference_price: 120,
      entry_price: 120.2,
      stop_pct: 1.8,
      tp_pct: 1.0,
      thesis: 'NVDA 1-3m uptrend with higher lows.',
      risks: 'Chip cycle and valuation compression.',
      why_now: 'Pullback offers a small paper probe.',
      rationale:
        'NVDA 1-3m uptrend with higher lows; semiconductor demand supports a small paper probe within budget.',
    },
  ],
  residual: [],
  notes: 'paper pipeline test',
};

console.log('=== IBKR paper pipeline test ===');
console.log('owner', owner);
console.log('gateway', {
  paper: cfg.isPaper,
  tradingEnabled: cfg.tradingEnabled,
  port: process.env.IBKR_PORT || 7497,
});
console.log('policy budget', policy.daily_budget_usd, 'max trades', policy.max_trades_per_day);

const pre = ledger.preflight(owner, {
  cashUsd: 1000,
  budgetUsd: policy.daily_budget_usd,
  maxTradesPerDay: policy.max_trades_per_day,
});
console.log('\n1) preflight', { ok: pre.ok, spendable: pre.status?.spendable_usd, trades_remaining: pre.status?.trades_remaining });
if (!pre.ok) {
  console.error('FAIL preflight', pre.error);
  process.exit(1);
}

const val = ledger.validateAndPreview(owner, samplePlan, {
  cashUsd: 1000,
  allowlist: policy.allowlist,
  allowlistKeys: policy.allowlist_keys,
  policy,
  budgetUsd: policy.daily_budget_usd,
  maxTradesPerDay: policy.max_trades_per_day,
  minRationaleChars: 40,
});
console.log('\n2) validate', {
  ok: val.ok,
  place: val.trades_to_place?.length,
  residual: val.residual?.length,
  error: val.error,
});
if (!val.ok || !val.trades_to_place?.length) {
  console.error('FAIL validate', val);
  process.exit(1);
}

const place = ledger.recordPlaceAttempt(owner, val.trades_to_place, { dryRun: true });
console.log('\n3) dry-run place', {
  ok: place.ok,
  dry_run: place.dry_run,
  reservations: place.reservations?.length,
  message: place.message,
  brackets: place.brackets,
});
if (!place.ok) {
  console.error('FAIL place', place);
  process.exit(1);
}

const status = ledger.getDayStatus(owner, { cashUsd: 1000 });
console.log('\n4) day-status', {
  reserved_usd: status.reserved_usd,
  trades_placed: status.trades_placed,
  budget_remaining_usd: status.budget_remaining_usd,
});

// Gateway check
const net = await import('net');
const port = Number(process.env.IBKR_PORT || 7497);
const gatewayUp = await new Promise((resolve) => {
  const s = net.createConnection({ host: '127.0.0.1', port }, () => {
    s.end();
    resolve(true);
  });
  s.on('error', () => resolve(false));
  setTimeout(() => resolve(false), 2000);
});
console.log('\n5) IB Gateway', gatewayUp ? `UP on ${port}` : `DOWN on ${port} — start TWS/Gateway paper before live MCP`);

console.log('\nPASS paper ledger pipeline');
process.exit(0);
