/**
 * Verify content-tool registration + invoke path for IBKR analytics tools.
 * Usage: node scripts/test-ibkr-analytics-agent-tools.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import { seedIbkrTradingToolsIfMissing } from '../src/db/seed-ibkr-trading-tools.js';
import { createSession } from '../src/services/auth/session.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

initDb();
seedIbkrTradingToolsIfMissing();

const BASE = (process.env.AGENT_OS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const owner = getBalaCeoAuthId();
const session = createSession(owner);
const token = session.token;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else console.log('OK:', msg);
}

const needed = [
  'ibkr_portfolio_analytics',
  'ibkr_fills_history',
  'ibkr_pnl',
  'ibkr_cash_events',
];
const db = getDb();
for (const name of needed) {
  const row = db.prepare('SELECT name, endpoint, enabled FROM content_tools_meta WHERE name=?').get(name);
  assert(!!row && row.enabled, `tool seeded: ${name}`);
}

async function invoke(name, params = {}) {
  const res = await fetch(`${BASE}/api/tools/test/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
if (!health?.ok) {
  console.error('Backend not up');
  process.exit(1);
}

console.log('\n=== Invoke analytics tools as CEO ===');
const a = await invoke('ibkr_portfolio_analytics', { days: 14, include_live: false });
assert(a.status === 200 || a.data?.ok || a.data?.result?.ok, `portfolio tool status=${a.status} ${JSON.stringify(a.data).slice(0, 200)}`);

const f = await invoke('ibkr_fills_history', {});
assert(f.status === 200 || f.data?.ok || Array.isArray(f.data?.fills || f.data?.result?.fills), `fills tool ${f.status}`);

const p = await invoke('ibkr_pnl', {});
assert(p.status === 200 || p.data?.ok != null || p.data?.result?.ok != null, `pnl tool ${p.status}`);

console.log(failed ? `\nFAILED ${failed}` : '\nALL AGENT TOOL TESTS PASSED');
process.exit(failed ? 1 : 0);
