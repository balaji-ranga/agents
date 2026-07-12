/**
 * Unit/integration tests for IBKR analytics data gaps (no live Gateway required).
 * Usage: node scripts/test-ibkr-analytics-gaps.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import * as ledger from '../src/services/ibkr-trading-ledger.js';
import {
  ensureIbkrAnalyticsTables,
  recordFill,
  persistAccountAnalyticsSnapshot,
  listFills,
  listPositionSnapshots,
  listRealizedPnl,
  listCashEvents,
  getPortfolioAnalytics,
} from '../src/services/ibkr-analytics.js';

initDb();
ledger.ensureIbkrLedgerTables();
ensureIbkrAnalyticsTables();

const owner = getBalaCeoAuthId();
const other = 'ceo-entitlement-other-test';
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('OK:', msg);
  }
}

// Isolate test rows with unique symbol
const SYM = `TEST:GAP${Date.now().toString(36).toUpperCase()}`;

console.log('\n=== 1) Durable fill via confirmFill ===');
ledger.getDayStatus(owner, { budgetUsd: 1000 });
const reserved = ledger.reserveTrades(
  owner,
  [
    {
      key: SYM,
      side: 'BUY',
      qty: 2,
      entry_price: 50,
      notional_usd: 100,
      reference_price: 50,
      stop_pct: 1.5,
      tp_pct: 1,
      rationale: 'analytics gap test fill path '.repeat(3),
    },
  ],
  { budgetUsd: 1000, maxTradesPerDay: 10 }
);
assert(reserved.ok, `reserve ok (${reserved.error || ''})`);
const resId = reserved.reservations?.[0]?.id;
assert(!!resId, `got reservation id ${resId}`);

const filled = ledger.confirmFill(resId, {
  fillPrice: 50.25,
  fillQty: 2,
  source: 'test_gaps',
});
assert(filled.ok, 'confirmFill ok');
assert(filled.fill?.fill_id, `fill recorded id=${filled.fill?.fill_id}`);
const fills = listFills(owner, { days: 1, symbolKey: SYM });
assert(fills.length >= 1, `listFills has ${fills.length} for ${SYM}`);
assert(Number(fills[0].fill_price) === 50.25, `fill_price=${fills[0].fill_price}`);

console.log('\n=== 2) Dedup fill on same reservation ===');
const dup = recordFill({
  ownerUserId: owner,
  reservationId: resId,
  symbolKey: SYM,
  side: 'BUY',
  qty: 2,
  fillPrice: 99,
  source: 'test_dup',
});
assert(dup.deduped === true, 'second fill deduped');

console.log('\n=== 3) Position snapshot + unrealized PnL ===');
const snap = persistAccountAnalyticsSnapshot(owner, {
  positions: [
    {
      key: SYM,
      symbol: SYM.split(':')[1],
      exchange: 'TEST',
      currency: 'USD',
      qty: 2,
      avg_cost: 50.25,
    },
  ],
  cashUsd: 999500,
  referencePrices: { [SYM]: 52 },
  source: 'test_gaps',
});
assert(snap.ok && snap.position_rows === 1, `snapshot rows=${snap.position_rows}`);
assert(Math.abs(snap.unrealized_pnl_usd - 3.5) < 0.01, `unrealized=${snap.unrealized_pnl_usd}`);
const pos = listPositionSnapshots(owner, { latestOnly: true }).filter((p) => p.symbol_key === SYM);
assert(pos.length === 1 && Number(pos[0].unrealized_pnl_usd) === 3.5, 'snapshot unrealized stored');

console.log('\n=== 4) Realized PnL on SELL fill ===');
const sell = recordFill({
  ownerUserId: owner,
  symbolKey: SYM,
  side: 'SELL_TO_CLOSE',
  qty: 1,
  fillPrice: 53,
  avgCostForPnl: 50.25,
  source: 'test_gaps_sell',
});
assert(sell.ok && sell.realized?.realized_pnl_usd === 2.75, `realized=${sell.realized?.realized_pnl_usd}`);
const pnlRows = listRealizedPnl(owner, { days: 1 }).filter((r) => r.symbol_key === SYM);
assert(pnlRows.length >= 1, 'realized row present');

console.log('\n=== 5) Cash events / pending deposit-like ===');
persistAccountAnalyticsSnapshot(owner, {
  positions: [],
  cashUsd: 999500,
  source: 'test_gaps_cash1',
});
persistAccountAnalyticsSnapshot(owner, {
  positions: [],
  cashUsd: 1000500,
  source: 'test_gaps_cash2',
});
const pending = listCashEvents(owner, { days: 1, pendingOnly: true });
assert(
  pending.some((e) => e.event_type === 'inferred_inflow' && Number(e.amount_usd) > 0),
  `pending inflow events=${pending.length}`
);

console.log('\n=== 6) Entitlement: other owner sees empty ===');
const otherFills = listFills(other, { days: 1, symbolKey: SYM });
assert(otherFills.length === 0, 'other owner cannot see fills');

console.log('\n=== 7) Portfolio analytics (no live) ===');
const summary = await getPortfolioAnalytics(owner, { days: 7, includeLive: false });
assert(summary.ok, 'summary ok');
assert(summary.trades.fills_count >= 1, `fills_count=${summary.trades.fills_count}`);
assert(summary.budget.budget_usd != null, 'budget present');

// cleanup test reservation noise — leave analytics rows (harmless TEST: symbols)
console.log(failed ? `\nFAILED ${failed}` : '\nALL GAP TESTS PASSED');
process.exit(failed ? 1 : 0);
