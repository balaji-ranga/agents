/**
 * Reset today's reserved (not filled) IBKR ledger rows so paper E2E has budget.
 * Usage: node scripts/reset-ibkr-day-reservations.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import * as ledger from '../src/services/ibkr-trading-ledger.js';

initDb();
const owner = getBalaCeoAuthId();
const db = getDb();
const day = new Date().toISOString().slice(0, 10);
const rows = db
  .prepare(
    `SELECT id, status, notional_usd, symbol_key FROM ibkr_trade_reservations
     WHERE owner_user_id = ? AND day = ? AND status = 'reserved'`
  )
  .all(owner, day);
console.log('Releasing', rows.length, 'reserved rows for', day);
for (const r of rows) {
  const out = ledger.releaseReservation(r.id, { reason: 'e2e_reset' });
  console.log(' released', r.id, r.symbol_key, out.ok);
}
console.log('day_status', ledger.getDayStatus(owner, { day }));
