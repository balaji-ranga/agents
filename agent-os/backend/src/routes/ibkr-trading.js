/**
 * IBKR paper trading budget / validate / reserve / snapshot API.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getIbkrTradingConfig, findAllowlistEntry } from '../services/ibkr-trading-rules.js';
import * as ledger from '../services/ibkr-trading-ledger.js';
import { getDb } from '../db/schema.js';
import * as store from '../services/agent-workflow-store.js';
import { resolveIbkrPolicy } from '../services/ibkr-workflow-variables.js';

const router = Router();

/**
 * Policy from the IBKR day-plan workflow definition variables (+ request body overrides).
 * No platform .env policy / no hardcoded ticker catalog.
 */
function resolveWorkflowBudgetOpts(req) {
  const def = store.getDefinition('ibkr-maker-checker-paper');
  const body = req.body || {};
  const merged = {
    ...(def?.variables || {}),
    ...(body.allowlist != null ? { allowlist: body.allowlist } : {}),
    ...(body.allowlist_keys != null || body.allowlistKeys != null
      ? { allowlist_keys: body.allowlist_keys || body.allowlistKeys }
      : {}),
    ...(body.daily_budget_usd != null || body.budget_usd != null
      ? { daily_budget_usd: body.daily_budget_usd ?? body.budget_usd }
      : {}),
    ...(body.max_trades_per_day != null ? { max_trades_per_day: body.max_trades_per_day } : {}),
    ...(body.min_rationale_chars != null ? { min_rationale_chars: body.min_rationale_chars } : {}),
    ...(body.block_duplicate_buys != null ? { block_duplicate_buys: body.block_duplicate_buys } : {}),
    ...(body.require_live_cash != null ? { require_live_cash: body.require_live_cash } : {}),
    ...(body.stop_pct_min != null ? { stop_pct_min: body.stop_pct_min } : {}),
    ...(body.stop_pct_max != null ? { stop_pct_max: body.stop_pct_max } : {}),
    ...(body.tp_pct_min != null ? { tp_pct_min: body.tp_pct_min } : {}),
    ...(body.tp_pct_max != null ? { tp_pct_max: body.tp_pct_max } : {}),
    ...(body.entry_slip_pct_max != null ? { entry_slip_pct_max: body.entry_slip_pct_max } : {}),
    ...(body.sgd_usd_rate != null ? { sgd_usd_rate: body.sgd_usd_rate } : {}),
    ...(body.max_hold_days != null ? { max_hold_days: body.max_hold_days } : {}),
  };
  const policy = resolveIbkrPolicy(merged);
  return {
    policy,
    dailyBudgetUsd: policy.daily_budget_usd,
    maxTradesPerDay: policy.max_trades_per_day,
    allowlist: policy.allowlist,
    allowlistKeys: policy.allowlist_keys,
    minRationaleChars: policy.min_rationale_chars,
    blockDuplicateBuys: policy.block_duplicate_buys,
    requireLiveCash: policy.require_live_cash,
    maxHoldDays: policy.max_hold_days,
  };
}

function allowInternalOrAuth(req, res, next) {
  if (req.headers['x-internal-test'] === '1') {
    req.authUser = req.authUser || {
      id: req.body?.owner_user_id || process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala',
      role: 'ceo',
    };
    return next();
  }
  return requireAuth(req, res, next);
}

function enrichPositions(positions = [], catalog = null) {
  return (positions || []).map((p) => {
    const meta = findAllowlistEntry(p.key || `${p.exchange}:${p.symbol}` || p.symbol, catalog);
    return {
      ...p,
      key: meta?.key || p.key || `${p.exchange || 'SMART'}:${p.symbol}`,
      symbol: meta?.symbol || p.symbol,
    };
  });
}

function syncPositionMeta(ownerUserId, positions = [], catalog = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO ibkr_position_meta (owner_user_id, symbol_key, opened_at, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(owner_user_id, symbol_key) DO UPDATE SET updated_at = datetime('now')`
  );
  for (const p of enrichPositions(positions, catalog)) {
    if (!(Number(p.qty) > 0) || !p.key) continue;
    const existing = db
      .prepare('SELECT opened_at FROM ibkr_position_meta WHERE owner_user_id = ? AND symbol_key = ?')
      .get(ownerUserId, p.key);
    if (!existing) upsert.run(ownerUserId, p.key, now);
    else upsert.run(ownerUserId, p.key, existing.opened_at || now);
  }
}

function ageDays(openedAt) {
  if (!openedAt) return 0;
  const t = Date.parse(openedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

router.use(allowInternalOrAuth);

router.get('/config', (req, res) => {
  const budgetOpts = resolveWorkflowBudgetOpts(req);
  res.json({
    gateway: getIbkrTradingConfig(),
    policy: budgetOpts.policy,
    allowlist: budgetOpts.allowlist,
    allowlist_keys: budgetOpts.allowlistKeys,
    source: 'workflow_variables',
  });
});

router.get('/day-status', (req, res) => {
  try {
    const owner = req.authUser.id;
    const cashUsd = req.query.cash_usd != null ? Number(req.query.cash_usd) : null;
    res.json(ledger.getDayStatus(owner, { cashUsd }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/account-snapshot', async (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const budgetOpts = resolveWorkflowBudgetOpts(req);
    const { fetchAccountSnapshot } = await import('../services/ibkr-gateway-client.js');
    const {
      reconcileReservationsWithBroker,
      buildOrderLearnings,
      ensureIbkrOrderEventTables,
    } = await import('../services/ibkr-order-events.js');
    ensureIbkrOrderEventTables();
    const snap = await fetchAccountSnapshot({ allowlist: budgetOpts.allowlist });
    const positions = enrichPositions(snap.positions || [], budgetOpts.allowlist);
    syncPositionMeta(owner, positions, budgetOpts.allowlist);

    const reconcile = await reconcileReservationsWithBroker(owner, {
      openOrders: snap.open_orders || [],
      positions,
    });
    const order_learnings = buildOrderLearnings(owner, { days: 30, limit: 40 });

    const db = getDb();
    const withAge = positions.map((p) => {
      const meta = db
        .prepare('SELECT opened_at, hold_until, last_review_at FROM ibkr_position_meta WHERE owner_user_id = ? AND symbol_key = ?')
        .get(owner, p.key);
      return {
        ...p,
        opened_at: meta?.opened_at || null,
        hold_until: meta?.hold_until || null,
        age_days: ageDays(meta?.opened_at),
      };
    });
    const day = ledger.getDayStatus(owner, {
      cashUsd: snap.cash_usd,
      budgetUsd: budgetOpts.dailyBudgetUsd,
      maxTradesPerDay: budgetOpts.maxTradesPerDay,
      allowlistKeys: budgetOpts.allowlistKeys,
    });
    const body = {
      ...snap,
      positions: withAge,
      day_status: day,
      daily_budget_usd: budgetOpts.dailyBudgetUsd,
      max_trades_per_day: budgetOpts.maxTradesPerDay,
      allowlist_keys: budgetOpts.allowlistKeys,
      allowlist: budgetOpts.allowlist,
      min_rationale_chars: budgetOpts.minRationaleChars,
      block_duplicate_buys: budgetOpts.blockDuplicateBuys,
      require_live_cash: budgetOpts.requireLiveCash,
      reconcile,
      order_learnings,
      ok: true,
      bodyText: null,
    };
    body.bodyText = JSON.stringify(body);
    res.json(body);
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

router.post('/preflight', async (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const cfg = getIbkrTradingConfig();
    const budgetOpts = resolveWorkflowBudgetOpts(req);
    let cashUsd = req.body?.cash_usd != null ? Number(req.body.cash_usd) : null;
    let snapshot = req.body?.snapshot || null;
    const requireLiveCash = budgetOpts.requireLiveCash;

    if (cashUsd == null && requireLiveCash) {
      try {
        const { fetchAccountSnapshot } = await import('../services/ibkr-gateway-client.js');
        snapshot = await fetchAccountSnapshot();
        cashUsd = snapshot.cash_usd;
        syncPositionMeta(owner, enrichPositions(snapshot.positions || [], budgetOpts.allowlist), budgetOpts.allowlist);
      } catch (e) {
        if (cfg.tradingEnabled) {
          return res.status(503).json({
            ok: false,
            error: `Live cash required but Gateway snapshot failed: ${e.message}`,
          });
        }
      }
    }

    if (cashUsd == null && cfg.tradingEnabled && requireLiveCash) {
      return res.status(400).json({ ok: false, error: 'cash_usd required when trading enabled' });
    }

    const result = ledger.preflight(owner, {
      cashUsd,
      budgetUsd: budgetOpts.dailyBudgetUsd,
      maxTradesPerDay: budgetOpts.maxTradesPerDay,
    });
    res.json({
      ...result,
      daily_budget_usd: budgetOpts.dailyBudgetUsd,
      max_trades_per_day: budgetOpts.maxTradesPerDay,
      allowlist_keys: budgetOpts.allowlistKeys,
      allowlist: budgetOpts.allowlist,
      snapshot: snapshot
        ? {
            cash_usd: snapshot.cash_usd,
            positions: enrichPositions(snapshot.positions || [], budgetOpts.allowlist),
            pending_sell_symbols: snapshot.pending_sell_symbols || [],
            open_orders_count: (snapshot.open_orders || []).length,
          }
        : null,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/validate-plan', async (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const budgetOpts = resolveWorkflowBudgetOpts(req);
    let plan = req.body?.plan ?? req.body?.text ?? req.body;
    if (plan && typeof plan === 'object' && plan.trades == null && plan.plan == null && req.body?.trades) {
      plan = req.body;
    }
    if (plan && typeof plan === 'object' && Array.isArray(plan.trades)) {
      // ok
    } else if (typeof req.body === 'string') {
      plan = req.body;
    }
    let snap = req.body?.snapshot || {};
    let cashUsd =
      req.body?.cash_usd != null
        ? Number(req.body.cash_usd)
        : snap.cash_usd != null
          ? Number(snap.cash_usd)
          : null;
    let positions = req.body?.positions || snap.positions || [];
    let pendingSellSymbols = req.body?.pending_sell_symbols || snap.pending_sell_symbols || [];

    if (cashUsd == null || !positions.length) {
      try {
        const { fetchAccountSnapshot } = await import('../services/ibkr-gateway-client.js');
        const live = await fetchAccountSnapshot();
        cashUsd = cashUsd ?? live.cash_usd;
        if (!positions.length) positions = enrichPositions(live.positions || [], budgetOpts.allowlist);
        if (!pendingSellSymbols.length) pendingSellSymbols = live.pending_sell_symbols || [];
        syncPositionMeta(owner, positions, budgetOpts.allowlist);
      } catch {
        /* optional when trading disabled */
      }
    }

    const result = ledger.validateAndPreview(owner, plan, {
      cashUsd,
      positions: enrichPositions(positions, budgetOpts.allowlist),
      allowlist: budgetOpts.allowlist,
      allowlistKeys: budgetOpts.allowlistKeys,
      policy: budgetOpts.policy,
      pendingSellSymbols,
      blockDuplicateBuys: budgetOpts.blockDuplicateBuys,
      minRationaleChars: budgetOpts.minRationaleChars,
      budgetUsd: budgetOpts.dailyBudgetUsd,
      maxTradesPerDay: budgetOpts.maxTradesPerDay,
    });
    const payload = {
      ...result,
      source: 'dayplan',
      cancel_source: 'dayplan',
      bodyText: null,
    };
    payload.bodyText = JSON.stringify(payload);
    res.status(result.ok ? 200 : 400).json(payload);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/exit-candidates', (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const budgetOpts = resolveWorkflowBudgetOpts(req);
    const maxHoldDays = Number(
      req.query.max_hold_days || req.body?.max_hold_days || budgetOpts.maxHoldDays || 5
    );
    const positions = enrichPositions(req.body?.positions || [], budgetOpts.allowlist);
    const db = getDb();
    const candidates = [];
    for (const p of positions) {
      if (!(Number(p.qty) > 0)) continue;
      const meta = db
        .prepare('SELECT opened_at, hold_until FROM ibkr_position_meta WHERE owner_user_id = ? AND symbol_key = ?')
        .get(owner, p.key);
      const opened = meta?.opened_at || p.opened_at;
      const holdUntil = meta?.hold_until;
      if (holdUntil && Date.parse(holdUntil) > Date.now()) continue;
      const age = ageDays(opened);
      if (age >= maxHoldDays) {
        candidates.push({ ...p, opened_at: opened, age_days: age, max_hold_days: maxHoldDays });
      }
    }
    res.json({
      ok: true,
      has_candidates: candidates.length > 0,
      candidates,
      count: candidates.length,
      text: candidates.length ? 'true' : 'false',
      bodyText: JSON.stringify({ ok: true, has_candidates: candidates.length > 0, candidates }),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/record-hold', (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const key = String(req.body?.key || '').toUpperCase();
    const extendDays = Number(req.body?.extend_days || 1);
    const db = getDb();
    const until = new Date(Date.now() + extendDays * 86400000).toISOString();
    db.prepare(
      `INSERT INTO ibkr_position_meta (owner_user_id, symbol_key, hold_until, last_review_at, last_review_json, updated_at)
       VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))
       ON CONFLICT(owner_user_id, symbol_key) DO UPDATE SET
         hold_until = excluded.hold_until,
         last_review_at = datetime('now'),
         last_review_json = excluded.last_review_json,
         updated_at = datetime('now')`
    ).run(owner, key, until, JSON.stringify(req.body?.review || { decision: 'HOLD', extend_days: extendDays }));
    res.json({ ok: true, key, hold_until: until });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/record-holds-batch', (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const holds = req.body?.holds || [];
    const db = getDb();
    const out = [];
    for (const h of holds) {
      const key = String(h.key || '').toUpperCase();
      if (!key) continue;
      const extendDays = Number(h.extend_days || 1);
      const until = new Date(Date.now() + extendDays * 86400000).toISOString();
      db.prepare(
        `INSERT INTO ibkr_position_meta (owner_user_id, symbol_key, hold_until, last_review_at, last_review_json, updated_at)
         VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))
         ON CONFLICT(owner_user_id, symbol_key) DO UPDATE SET
           hold_until = excluded.hold_until,
           last_review_at = datetime('now'),
           last_review_json = excluded.last_review_json,
           updated_at = datetime('now')`
      ).run(owner, key, until, JSON.stringify(h.review || h));
      out.push({ key, hold_until: until });
    }
    res.json({ ok: true, recorded: out });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/reserve', (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const trades = req.body?.trades_to_place || req.body?.trades || [];
    const residual = req.body?.residual || [];
    const runId = req.body?.run_id ?? null;
    const reserved = ledger.reserveTrades(owner, trades, { runId });
    if (reserved.ok && residual.length) ledger.saveResidual(owner, residual);
    res.status(reserved.ok ? 200 : 400).json(reserved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/release', (req, res) => {
  try {
    const id = Number(req.body?.reservation_id || req.body?.id);
    const reason = req.body?.reason || 'rejected';
    res.json(ledger.releaseReservation(id, { reason }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/confirm-fill', (req, res) => {
  try {
    const id = Number(req.body?.reservation_id || req.body?.id);
    res.json(ledger.confirmFill(id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/place', async (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const budgetOpts = resolveWorkflowBudgetOpts(req);
    const cancelSource =
      req.body?.cancel_source ||
      req.body?.workflow_source ||
      (req.body?.source === 'poller' ? 'poller' : req.body?.source === 'dayplan' ? 'dayplan' : 'before_sell');
    let trades = req.body?.trades_to_place || req.body?.trades || [];
    // Ensure Gateway gets secType/exchange from workflow allowlist
    trades = (trades || []).map((t) => {
      const meta = findAllowlistEntry(t.key || t.symbol, budgetOpts.allowlist);
      const base = meta
        ? {
            ...t,
            key: meta.key,
            symbol: meta.symbol,
            exchange: meta.exchange,
            currency: meta.currency,
            secType: meta.secType,
            market: meta.market,
          }
        : { ...t };
      return {
        ...base,
        owner_user_id: owner,
        cancel_source:
          t.cancel_source ||
          (String(t.side || '').toUpperCase().includes('SELL') ? cancelSource : undefined),
      };
    });
    const residual = req.body?.residual || [];
    const runId = req.body?.run_id ?? null;
    const dryRun = req.body?.dry_run !== false && !getIbkrTradingConfig().tradingEnabled;
    if (residual.length) ledger.saveResidual(owner, residual);
    const result = await ledger.recordPlaceAttempt(owner, trades, {
      runId,
      dryRun,
      budgetUsd: budgetOpts.dailyBudgetUsd,
      maxTradesPerDay: budgetOpts.maxTradesPerDay,
    });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/reconcile-orders', async (req, res) => {
  try {
    const owner = req.body?.owner_user_id || req.authUser.id;
    const budgetOpts = resolveWorkflowBudgetOpts(req);
    const { fetchAccountSnapshot } = await import('../services/ibkr-gateway-client.js');
    const { reconcileReservationsWithBroker, buildOrderLearnings } = await import(
      '../services/ibkr-order-events.js'
    );
    const snap = await fetchAccountSnapshot({ allowlist: budgetOpts.allowlist });
    const positions = enrichPositions(snap.positions || [], budgetOpts.allowlist);
    const reconcile = await reconcileReservationsWithBroker(owner, {
      openOrders: snap.open_orders || [],
      positions,
      graceSec: req.body?.grace_sec != null ? Number(req.body.grace_sec) : undefined,
    });
    res.json({
      ok: true,
      reconcile,
      day_status: ledger.getDayStatus(owner, {
        cashUsd: snap.cash_usd,
        budgetUsd: budgetOpts.dailyBudgetUsd,
        maxTradesPerDay: budgetOpts.maxTradesPerDay,
      }),
      order_learnings: buildOrderLearnings(owner),
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

router.get('/order-events', async (req, res) => {
  try {
    const owner = req.query.owner_user_id || req.authUser.id;
    const days = req.query.days != null ? Number(req.query.days) : 30;
    const limit = req.query.limit != null ? Number(req.query.limit) : 100;
    const symbolKey = req.query.symbol_key || req.query.key || null;
    const { listOrderEvents, buildOrderLearnings, ensureIbkrOrderEventTables } = await import(
      '../services/ibkr-order-events.js'
    );
    ensureIbkrOrderEventTables();
    const events = listOrderEvents(owner, { days, limit, symbolKey });
    res.json({
      ok: true,
      events,
      order_learnings: buildOrderLearnings(owner, { days, limit }),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/order-learnings', async (req, res) => {
  try {
    const owner = req.query.owner_user_id || req.authUser.id;
    const days = req.query.days != null ? Number(req.query.days) : 30;
    const { buildOrderLearnings, ensureIbkrOrderEventTables } = await import(
      '../services/ibkr-order-events.js'
    );
    ensureIbkrOrderEventTables();
    res.json({ ok: true, ...buildOrderLearnings(owner, { days }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/gateway-ping', async (_req, res) => {
  try {
    const { pingIbGateway } = await import('../services/ibkr-gateway-client.js');
    const result = await pingIbGateway();
    res.json(result);
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

export default router;
