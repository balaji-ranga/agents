/**
 * Grant IBKR analytics tools to COO and verify invoke entitlement.
 * Usage: node scripts/test-coo-ibkr-analytics-grants.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import {
  seedIbkrTradingToolsIfMissing,
  IBKR_ANALYTICS_TOOL_NAMES,
  grantIbkrToolsToCoo,
} from '../src/db/seed-ibkr-trading-tools.js';
import { assertCallerMayUseTool, getAgentToolGrants } from '../src/services/openclaw-agent-tools.js';
import { createSession } from '../src/services/auth/session.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

initDb();
seedIbkrTradingToolsIfMissing();
const grantResult = grantIbkrToolsToCoo('balserve');

const BASE = (process.env.AGENT_OS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const owner = getBalaCeoAuthId();
const token = createSession(owner).token;
const db = getDb();
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else console.log('OK:', msg);
}

const grants = getAgentToolGrants('balserve');
for (const name of IBKR_ANALYTICS_TOOL_NAMES) {
  assert(grants.includes(name), `COO grant includes ${name}`);
  const check = assertCallerMayUseTool('balserve', name);
  assert(check.ok, `assertCallerMayUseTool balserve/${name}: ${check.error || 'ok'}`);
}
assert(grantResult.agent_id === 'balserve', `grant target ${grantResult.agent_id}`);

const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
if (!health?.ok) {
  console.error('Backend not up at', BASE);
  process.exit(1);
}

async function invokeAsCoo(name, body = {}) {
  const res = await fetch(`${BASE}/api/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-agent-id': 'balserve',
      'x-openclaw-agent-id': 'balserve',
    },
    body: JSON.stringify({ tool_name: name, caller_agent_id: 'balserve', ...body }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log('\n=== COO invoke analytics ===');
const a = await invokeAsCoo('ibkr_portfolio_analytics', { days: 14, include_live: false });
assert(
  a.status === 200 && (a.data?.ok === true || a.data?.result?.ok === true || a.data?.days != null || a.data?.result?.days != null),
  `portfolio analytics status=${a.status} keys=${Object.keys(a.data || {}).join(',')}`
);

const f = await invokeAsCoo('ibkr_fills_history', {});
assert(f.status === 200, `fills history status=${f.status}`);

const p = await invokeAsCoo('ibkr_pnl', {});
assert(p.status === 200, `pnl status=${p.status}`);

const c = await invokeAsCoo('ibkr_cash_events', {});
assert(c.status === 200, `cash events status=${c.status}`);

console.log(
  db
    .prepare(
      `SELECT tool_name FROM agent_tool_grants WHERE agent_id='balserve' AND tool_name LIKE 'ibkr%' ORDER BY tool_name`
    )
    .all()
);

console.log(failed ? `\nFAILED ${failed}` : '\nALL COO IBKR ANALYTICS TESTS PASSED');
process.exit(failed ? 1 : 0);
