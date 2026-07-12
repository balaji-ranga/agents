/**
 * USD budget ledger + trade reservations for IBKR paper workflow.
 * Placement reserves notional until reject/cancel; fills keep it consumed.
 */
import { getDb } from '../db/schema.js';
import { getIbkrTradingConfig, validateTradePlanStrict } from './ibkr-trading-rules.js';
import { IBKR_POLICY_DEFAULTS } from './ibkr-workflow-variables.js';
import { recordFill } from './ibkr-analytics.js';

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function ensureIbkrLedgerTables(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ibkr_budget_days (
      owner_user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      budget_usd REAL NOT NULL,
      reserved_usd REAL NOT NULL DEFAULT 0,
      consumed_usd REAL NOT NULL DEFAULT 0,
      trades_placed INTEGER NOT NULL DEFAULT 0,
      residual_json TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (owner_user_id, day)
    );

    CREATE TABLE IF NOT EXISTS ibkr_trade_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      run_id INTEGER,
      symbol_key TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      notional_usd REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      detail_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ibkr_reservations_owner_day
      ON ibkr_trade_reservations(owner_user_id, day, status);

    CREATE TABLE IF NOT EXISTS ibkr_order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL,
      reservation_id INTEGER,
      run_id INTEGER,
      symbol_key TEXT,
      symbol TEXT,
      side TEXT,
      ib_order_id INTEGER,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_text TEXT,
      source TEXT,
      error_code INTEGER,
      qty REAL,
      detail_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ibkr_order_events_owner_created
      ON ibkr_order_events(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ibkr_order_events_symbol
      ON ibkr_order_events(owner_user_id, symbol_key, created_at DESC);
  `);
}

function getOrCreateDay(ownerUserId, day = todayUtc(), { budgetUsd = null } = {}) {
  ensureIbkrLedgerTables();
  const db = getDb();
  const budget =
    budgetUsd != null && Number.isFinite(Number(budgetUsd))
      ? Number(budgetUsd)
      : IBKR_POLICY_DEFAULTS.daily_budget_usd;
  let row = db
    .prepare('SELECT * FROM ibkr_budget_days WHERE owner_user_id = ? AND day = ?')
    .get(ownerUserId, day);
  if (!row) {
    db.prepare(
      `INSERT INTO ibkr_budget_days (owner_user_id, day, budget_usd, reserved_usd, consumed_usd, trades_placed)
       VALUES (?, ?, ?, 0, 0, 0)`
    ).run(ownerUserId, day, budget);
    row = db
      .prepare('SELECT * FROM ibkr_budget_days WHERE owner_user_id = ? AND day = ?')
      .get(ownerUserId, day);
  } else if (budgetUsd != null && Number(row.budget_usd) !== budget) {
    db.prepare(
      `UPDATE ibkr_budget_days SET budget_usd = ?, updated_at = datetime('now') WHERE owner_user_id = ? AND day = ?`
    ).run(budget, ownerUserId, day);
    row = { ...row, budget_usd: budget };
  }
  return row;
}

export function getDayStatus(
  ownerUserId,
  { cashUsd = null, day = todayUtc(), budgetUsd = null, maxTradesPerDay = null, allowlistKeys = null } = {}
) {
  const cfg = getIbkrTradingConfig();
  const row = getOrCreateDay(ownerUserId, day, { budgetUsd });
  const reserved = Number(row.reserved_usd) || 0;
  const consumed = Number(row.consumed_usd) || 0;
  const budgetRemaining = Math.max(0, Number(row.budget_usd) - reserved - consumed);
  const cash = cashUsd == null ? budgetRemaining : Number(cashUsd);
  const spendable = Math.max(0, Math.min(budgetRemaining, cash));
  const maxTrades =
    maxTradesPerDay != null ? Number(maxTradesPerDay) : IBKR_POLICY_DEFAULTS.max_trades_per_day;
  return {
    day,
    budget_usd: Number(row.budget_usd),
    reserved_usd: reserved,
    consumed_usd: consumed,
    budget_remaining_usd: Number(budgetRemaining.toFixed(2)),
    trades_placed: Number(row.trades_placed) || 0,
    trades_remaining: Math.max(0, maxTrades - (Number(row.trades_placed) || 0)),
    spendable_usd: Number(spendable.toFixed(2)),
    cash_usd: cashUsd == null ? null : Number(cash),
    residual: JSON.parse(row.residual_json || '[]'),
    trading_enabled: cfg.tradingEnabled,
    is_paper: cfg.isPaper,
    allowlist_keys: Array.isArray(allowlistKeys) ? allowlistKeys : [],
    max_trades_per_day: maxTrades,
  };
}

export function preflight(
  ownerUserId,
  { cashUsd = null, budgetUsd = null, maxTradesPerDay = null } = {}
) {
  const status = getDayStatus(ownerUserId, { cashUsd, budgetUsd, maxTradesPerDay });
  const cfg = getIbkrTradingConfig();
  const ok = status.trades_remaining > 0 && status.spendable_usd > 0;
  return {
    ok,
    error: ok
      ? null
      : status.trades_remaining <= 0
        ? 'Daily trade limit reached'
        : 'No spendable budget/cash',
    status,
    config: cfg,
  };
}

export function validateAndPreview(
  ownerUserId,
  plan,
  {
    cashUsd = null,
    positions = [],
    allowlist = null,
    allowlistKeys = null,
    policy = null,
    pendingSellSymbols = [],
    blockDuplicateBuys = true,
    minRationaleChars = 80,
    budgetUsd = null,
    maxTradesPerDay = null,
  } = {}
) {
  const status = getDayStatus(ownerUserId, {
    cashUsd,
    budgetUsd,
    maxTradesPerDay,
    allowlistKeys,
  });
  const result = validateTradePlanStrict(plan, {
    cashUsd: cashUsd == null ? status.spendable_usd : cashUsd,
    budgetRemainingUsd: status.budget_remaining_usd,
    tradesUsed: status.trades_placed,
    positions,
    allowlist: allowlist || undefined,
    allowlistKeys: allowlistKeys || undefined,
    policy: policy || undefined,
    pendingSellSymbols,
    blockDuplicateBuys,
    minRationaleChars,
    maxTradesPerDay: maxTradesPerDay ?? status.max_trades_per_day,
  });
  return { ...result, day_status: status };
}

/**
 * Reserve notional for trades_to_place. Counts each as a trade placement.
 */
export function reserveTrades(
  ownerUserId,
  trades,
  { runId = null, day = todayUtc(), budgetUsd = null, maxTradesPerDay = null } = {}
) {
  ensureIbkrLedgerTables();
  const db = getDb();
  const status = getDayStatus(ownerUserId, { day, budgetUsd, maxTradesPerDay });
  const list = Array.isArray(trades) ? trades : [];
  if (!list.length) return { ok: false, error: 'No trades to reserve', reservations: [] };

  const maxTrades =
    maxTradesPerDay != null ? Number(maxTradesPerDay) : IBKR_POLICY_DEFAULTS.max_trades_per_day;
  if (status.trades_placed + list.length > maxTrades) {
    return { ok: false, error: 'Exceeds max trades per day', reservations: [] };
  }

  const buyUsd = list.filter((t) => t.side === 'BUY').reduce((s, t) => s + Number(t.notional_usd || 0), 0);
  if (buyUsd > status.budget_remaining_usd + 1e-6) {
    return { ok: false, error: 'Insufficient budget for reservations', reservations: [] };
  }

  const insert = db.prepare(
    `INSERT INTO ibkr_trade_reservations
      (owner_user_id, day, run_id, symbol_key, side, qty, notional_usd, status, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`
  );
  const reservations = [];
  const tx = db.transaction(() => {
    for (const t of list) {
      const info = insert.run(
        ownerUserId,
        day,
        runId,
        t.key || t.symbol_key,
        t.side,
        t.qty,
        Number(t.notional_usd || 0),
        JSON.stringify(t)
      );
      reservations.push({ id: info.lastInsertRowid, ...t, status: 'reserved' });
    }
    const buySum = list.filter((t) => t.side === 'BUY').reduce((s, t) => s + Number(t.notional_usd || 0), 0);
    db.prepare(
      `UPDATE ibkr_budget_days
       SET reserved_usd = reserved_usd + ?,
           trades_placed = trades_placed + ?,
           updated_at = datetime('now')
       WHERE owner_user_id = ? AND day = ?`
    ).run(buySum, list.length, ownerUserId, day);
  });
  tx();

  return { ok: true, reservations, day_status: getDayStatus(ownerUserId, { day }) };
}

export function releaseReservation(reservationId, { reason = 'rejected' } = {}) {
  ensureIbkrLedgerTables();
  const db = getDb();
  const row = db.prepare('SELECT * FROM ibkr_trade_reservations WHERE id = ?').get(reservationId);
  if (!row) return { ok: false, error: 'Reservation not found' };
  if (row.status !== 'reserved') return { ok: false, error: `Cannot release status=${row.status}` };

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE ibkr_trade_reservations SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(reason === 'cancelled' ? 'cancelled' : 'rejected', reservationId);
    if (row.side === 'BUY') {
      db.prepare(
        `UPDATE ibkr_budget_days
         SET reserved_usd = MAX(0, reserved_usd - ?),
             trades_placed = MAX(0, trades_placed - 1),
             updated_at = datetime('now')
         WHERE owner_user_id = ? AND day = ?`
      ).run(Number(row.notional_usd) || 0, row.owner_user_id, row.day);
    } else {
      db.prepare(
        `UPDATE ibkr_budget_days
         SET trades_placed = MAX(0, trades_placed - 1),
             updated_at = datetime('now')
         WHERE owner_user_id = ? AND day = ?`
      ).run(row.owner_user_id, row.day);
    }
  });
  tx();
  return { ok: true, day_status: getDayStatus(row.owner_user_id, { day: row.day }) };
}

/** Mark reserved → filled (keep budget consumed) and record durable fill. */
export function confirmFill(
  reservationId,
  { fillPrice = null, fillQty = null, ibOrderId = null, source = 'confirm_fill', avgCostForPnl = null } = {}
) {
  ensureIbkrLedgerTables();
  const db = getDb();
  const row = db.prepare('SELECT * FROM ibkr_trade_reservations WHERE id = ?').get(reservationId);
  if (!row) return { ok: false, error: 'Reservation not found' };
  if (row.status !== 'reserved') return { ok: false, error: `Cannot fill status=${row.status}` };

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE ibkr_trade_reservations SET status = 'filled', updated_at = datetime('now') WHERE id = ?`
    ).run(reservationId);
    if (row.side === 'BUY') {
      db.prepare(
        `UPDATE ibkr_budget_days
         SET reserved_usd = MAX(0, reserved_usd - ?),
             consumed_usd = consumed_usd + ?,
             updated_at = datetime('now')
         WHERE owner_user_id = ? AND day = ?`
      ).run(Number(row.notional_usd) || 0, Number(row.notional_usd) || 0, row.owner_user_id, row.day);
    }
  });
  tx();

  let fillResult = null;
  try {
    const detail = row.detail_json ? JSON.parse(row.detail_json) : {};
    const qty = fillQty != null ? Number(fillQty) : Number(row.qty);
    const price =
      fillPrice != null
        ? Number(fillPrice)
        : detail.entry_price != null
          ? Number(detail.entry_price)
          : Number(row.notional_usd) && qty
            ? Number(row.notional_usd) / qty
            : null;
    fillResult = recordFill({
      ownerUserId: row.owner_user_id,
      reservationId: row.id,
      runId: row.run_id,
      symbolKey: row.symbol_key,
      side: row.side,
      qty,
      fillPrice: price,
      notionalUsd: price != null && qty ? Number((price * qty).toFixed(4)) : Number(row.notional_usd),
      ibOrderId,
      source,
      avgCostForPnl,
      detail: { reservation_detail: detail },
    });
  } catch (e) {
    console.warn('[ibkr] recordFill after confirmFill:', e.message);
  }

  return {
    ok: true,
    day_status: getDayStatus(row.owner_user_id, { day: row.day }),
    fill: fillResult,
  };
}

export function saveResidual(ownerUserId, residual, { day = todayUtc() } = {}) {
  getOrCreateDay(ownerUserId, day);
  getDb()
    .prepare(
      `UPDATE ibkr_budget_days SET residual_json = ?, updated_at = datetime('now') WHERE owner_user_id = ? AND day = ?`
    )
    .run(JSON.stringify(residual || []), ownerUserId, day);
  return getDayStatus(ownerUserId, { day });
}

/** Dry-run or live Gateway place (brackets via @stoqey/ib when enabled). */
export async function recordPlaceAttempt(
  ownerUserId,
  trades,
  { runId = null, dryRun = true, budgetUsd = null, maxTradesPerDay = null } = {}
) {
  const cfg = getIbkrTradingConfig();
  const wantLive = cfg.tradingEnabled && !dryRun;
  const list = Array.isArray(trades) ? trades : [];
  if (!list.length) {
    return {
      ok: true,
      placed: false,
      dry_run: !wantLive,
      no_trade_day: true,
      message: 'No trades to place (empty day plan)',
      reservations: [],
      day_status: getDayStatus(ownerUserId, { budgetUsd, maxTradesPerDay }),
      brackets: [],
    };
  }
  const reserved = reserveTrades(ownerUserId, list, { runId, budgetUsd, maxTradesPerDay });
  if (!reserved.ok) return { ...reserved, placed: false, dry_run: true };

  const brackets = (trades || []).map((t) => ({
    key: t.key,
    side: t.side,
    qty: t.qty,
    entry: t.entry_price,
    stop: t.stop_price,
    take_profit: t.tp_price,
  }));

  if (!wantLive) {
    return {
      ok: true,
      placed: false,
      dry_run: true,
      message: 'IBKR_TRADING_ENABLED=0 — reserved only (dry-run place)',
      reservations: reserved.reservations,
      day_status: reserved.day_status,
      brackets,
    };
  }

  const { placeBracketTrades } = await import('./ibkr-gateway-client.js');
  const {
    recordOrderEvent,
    IBKR_ORDER_REASON,
    reasonFromIbMessage,
  } = await import('./ibkr-order-events.js');

  const submit = await placeBracketTrades(trades || [], {
    ownerUserId,
    runId,
    // Post-ack watch catches immediate IB system cancels (crypto paper, etc.)
    postAckWatchMs: 8000,
  });

  const byKey = new Map((reserved.reservations || []).map((r) => [String(r.key || r.symbol_key), r]));

  for (const gr of submit.results || []) {
    const resRow = byKey.get(String(gr.key || ''));
    if (gr.ok) {
      for (const oid of gr.orderIds || []) {
        recordOrderEvent({
          owner_user_id: ownerUserId,
          reservation_id: resRow?.id ?? null,
          run_id: runId,
          symbol_key: gr.key,
          symbol: gr.contract?.symbol || null,
          side: gr.side || resRow?.side,
          ib_order_id: oid,
          status: gr.terminal_status || 'Submitted',
          reason_code: gr.terminal_reason_code || IBKR_ORDER_REASON.PLACED_ACK,
          reason_text: gr.terminal_reason_text || 'Gateway openOrder ack',
          source: 'place',
          qty: resRow?.qty,
          detail: { orderIds: gr.orderIds, note: gr.note || null },
        });
      }
      // Immediate cancel after ack → release reservation
      if (gr.terminal_cancelled && resRow?.id) {
        releaseReservation(resRow.id, { reason: 'cancelled' });
        recordOrderEvent({
          owner_user_id: ownerUserId,
          reservation_id: resRow.id,
          run_id: runId,
          symbol_key: gr.key,
          side: gr.side || resRow.side,
          status: 'Cancelled',
          ...reasonFromIbMessage(gr.terminal_reason_text || 'IB cancelled after place ack'),
          source: 'place_watch',
          qty: resRow.qty,
        });
      } else if (
        !gr.terminal_cancelled &&
        String(gr.terminal_status || '').toLowerCase() === 'filled' &&
        resRow?.id
      ) {
        confirmFill(resRow.id, {
          fillPrice: gr.avg_fill_price ?? resRow.entry_price ?? null,
          fillQty: gr.filled_qty ?? resRow.qty,
          ibOrderId: (gr.orderIds || [])[0] ?? null,
          source: 'place_watch',
        });
        recordOrderEvent({
          owner_user_id: ownerUserId,
          reservation_id: resRow.id,
          run_id: runId,
          symbol_key: gr.key,
          side: gr.side || resRow.side,
          status: 'Filled',
          reason_code: IBKR_ORDER_REASON.FILLED,
          reason_text: gr.terminal_reason_text || 'Filled during post-ack watch',
          source: 'place_watch',
          qty: resRow.qty,
          detail: { avg_fill_price: gr.avg_fill_price ?? null },
        });
      }
    } else {
      const parsed = reasonFromIbMessage(gr.error || 'place failed', { status: 'Rejected' });
      recordOrderEvent({
        owner_user_id: ownerUserId,
        reservation_id: resRow?.id ?? null,
        run_id: runId,
        symbol_key: gr.key,
        side: resRow?.side,
        status: 'Rejected',
        reason_code: IBKR_ORDER_REASON.PLACE_FAILED,
        reason_text: gr.error || parsed.reason_text,
        source: 'place',
        qty: resRow?.qty,
      });
    }
  }

  if (!submit.ok) {
    for (const r of reserved.reservations || []) {
      // Skip already released by terminal_cancelled
      const still = getDb()
        .prepare('SELECT status FROM ibkr_trade_reservations WHERE id = ?')
        .get(r.id);
      if (still?.status === 'reserved') {
        releaseReservation(r.id, { reason: 'place_failed' });
      }
    }
    return {
      ok: false,
      placed: false,
      dry_run: false,
      error: 'One or more IBKR bracket submissions failed',
      gateway_results: submit.results,
      reservations: reserved.reservations,
      day_status: getDayStatus(ownerUserId),
      brackets,
    };
  }

  // Partial: some ok some cancelled after ack — still report placed if any survived
  return {
    ok: true,
    placed: true,
    dry_run: false,
    message: 'Submitted brackets to IB Gateway (paper)',
    gateway_results: submit.results,
    reservations: reserved.reservations,
    day_status: getDayStatus(ownerUserId),
    brackets,
  };
}
