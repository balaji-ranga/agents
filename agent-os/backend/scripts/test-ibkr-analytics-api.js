/**
 * HTTP tests for entitled IBKR analytics APIs.
 * Usage: node scripts/test-ibkr-analytics-api.js
 * Requires backend on :3001
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const BASE = (process.env.AGENT_OS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const h = { 'Content-Type': 'application/json', 'x-internal-test': '1' };
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else console.log('OK:', msg);
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log('=== Analytics API against', BASE, '===');

const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
if (!health?.ok) {
  console.error('Backend not up — start backend first');
  process.exit(1);
}

const summary = await req('POST', '/api/ibkr-trading/analytics/summary', {
  days: 30,
  include_live: false,
});
assert(summary.status === 200 && summary.data.ok, `summary status=${summary.status}`);
assert(summary.data.budget != null, 'summary.budget');
assert(summary.data.trades != null, 'summary.trades');
assert(summary.data.pnl != null, 'summary.pnl');

// Spoof other owner in body — entitledOwnerId must ignore it (session/internal user stays ceo-bala)
const spoof = await req('POST', '/api/ibkr-trading/analytics/summary', {
  days: 7,
  include_live: false,
  owner_user_id: 'ceo-someone-else-should-not-win',
});
assert(spoof.data.owner_user_id !== 'ceo-someone-else-should-not-win', `owner=${spoof.data.owner_user_id}`);

const fills = await req('GET', '/api/ibkr-trading/analytics/fills?days=30&limit=20');
assert(fills.status === 200 && fills.data.ok && Array.isArray(fills.data.fills), 'fills list');

const pnl = await req('GET', '/api/ibkr-trading/analytics/pnl?days=30');
assert(pnl.status === 200 && pnl.data.ok, 'pnl');

const cash = await req('GET', '/api/ibkr-trading/analytics/cash-events?days=30');
assert(cash.status === 200 && cash.data.ok && Array.isArray(cash.data.events), 'cash events');

const pos = await req('GET', '/api/ibkr-trading/analytics/positions?latest_only=1');
assert(pos.status === 200 && pos.data.ok && Array.isArray(pos.data.positions), 'positions');

// Regression: day-status still works
const day = await req('GET', '/api/ibkr-trading/day-status');
assert(day.status === 200 && day.data.budget_usd != null, 'day-status regression');

console.log(failed ? `\nFAILED ${failed}` : '\nALL ANALYTICS API TESTS PASSED');
process.exit(failed ? 1 : 0);
