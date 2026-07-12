/**
 * Hard trading rules for IBKR maker/checker workflow (no LLM trust).
 * Tradable instruments + policy come from workflow variables, not .env.
 */
import {
  findInAllowlist,
  normalizeAllowlist,
  allowlistKeysFrom,
  resolveIbkrPolicy,
  IBKR_POLICY_DEFAULTS,
} from './ibkr-workflow-variables.js';

function isQtyMultipleOfLot(qty, lot) {
  const q = Number(qty);
  const l = Number(lot);
  if (!(q > 0)) return false;
  if (!(l > 0)) return true;
  const n = q / l;
  return Math.abs(n - Math.round(n)) < 1e-8;
}

/**
 * Gateway / process safety flags only (connection secrets stay in .env).
 * Trading policy (budget, allowlist, stops) is NOT here — use resolveIbkrPolicy(workflow.variables).
 */
export function getIbkrTradingConfig() {
  return {
    tradingEnabled: process.env.IBKR_TRADING_ENABLED === '1' || process.env.IBKR_TRADING_ENABLED === 'true',
    isPaper: process.env.IBKR_IS_PAPER !== '0' && process.env.IBKR_IS_PAPER !== 'false',
  };
}

/**
 * Resolve instrument meta from a workflow allowlist catalog.
 * catalog required — empty/missing → not found.
 */
export function findAllowlistEntry(symbolOrKey, catalog = []) {
  return findInAllowlist(symbolOrKey, catalog);
}

export { normalizeAllowlist, allowlistKeysFrom, resolveIbkrPolicy, IBKR_POLICY_DEFAULTS };

export function toUsd(amount, currency, sgdUsdRate) {
  const n = Number(amount) || 0;
  const ccy = String(currency || 'USD').toUpperCase();
  if (ccy === 'USD') return n;
  if (ccy === 'SGD') return n * Number(sgdUsdRate || 0.74);
  return n;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function policyFromOpts(opts = {}) {
  if (opts.policy) return opts.policy;
  return resolveIbkrPolicy({
    allowlist: opts.allowlist || opts.allowlistInstruments,
    allowlist_keys: opts.allowlistKeys,
    daily_budget_usd: opts.dailyBudgetUsd ?? opts.daily_budget_usd,
    max_trades_per_day: opts.maxTradesPerDay ?? opts.max_trades_per_day,
    stop_pct_min: opts.stopPctMin ?? opts.stop_pct_min,
    stop_pct_max: opts.stopPctMax ?? opts.stop_pct_max,
    tp_pct_min: opts.tpPctMin ?? opts.tp_pct_min,
    tp_pct_max: opts.tpPctMax ?? opts.tp_pct_max,
    entry_slip_pct_max: opts.entrySlipPctMax ?? opts.entry_slip_pct_max,
    sgd_usd_rate: opts.sgdUsdRate ?? opts.sgd_usd_rate,
    min_rationale_chars: opts.minRationaleChars ?? opts.min_rationale_chars,
    block_duplicate_buys: opts.blockDuplicateBuys ?? opts.block_duplicate_buys,
  });
}

/**
 * Normalize maker JSON (object or string). Returns { ok, error, plan }.
 */
export function parseTradePlan(raw) {
  let plan = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : text;
    try {
      plan = JSON.parse(body);
    } catch {
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          plan = JSON.parse(body.slice(start, end + 1));
        } catch (e) {
          return { ok: false, error: `Invalid plan JSON: ${e.message}`, plan: null };
        }
      } else {
        return { ok: false, error: 'Invalid plan JSON', plan: null };
      }
    }
  }
  if (!plan || typeof plan !== 'object') return { ok: false, error: 'Plan must be an object', plan: null };
  return { ok: true, error: null, plan };
}

export function parseCheckerDecision(raw) {
  const parsed = parseTradePlan(raw);
  if (!parsed.ok) {
    const text = String(raw || '').toLowerCase();
    if (text.includes('approved') && !text.includes('rejected')) {
      return { ok: true, decision: 'approved', adjustments: '', notes: String(raw || ''), error: null };
    }
    if (text.includes('rejected')) {
      return { ok: true, decision: 'rejected', adjustments: String(raw || ''), notes: '', error: null };
    }
    return { ok: false, decision: 'rejected', adjustments: '', notes: '', error: parsed.error };
  }
  const d = parsed.plan;
  const decision = String(d.decision || d.verdict || '').toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, decision: 'rejected', adjustments: '', notes: '', error: 'Checker must set decision approved|rejected' };
  }
  return {
    ok: true,
    decision,
    adjustments: String(d.adjustments || d.recommendations || ''),
    notes: String(d.notes || ''),
    error: null,
    plan: d.plan || d.trade_plan || null,
  };
}

/**
 * Validate a day plan against hard gates. Does not touch the ledger.
 * opts.allowlist / opts.policy — from workflow variables (source of truth).
 */
export function validateTradePlan(planInput, opts = {}) {
  const policy = policyFromOpts(opts);
  const catalog = policy.allowlist.length
    ? policy.allowlist
    : normalizeAllowlist(opts.allowlist || opts.allowlistInstruments || []);
  const allowlistKeys =
    Array.isArray(opts.allowlistKeys) && opts.allowlistKeys.length
      ? opts.allowlistKeys.map((k) => String(k).toUpperCase())
      : catalog.map((a) => a.key);
  const cashUsd = Number(opts.cashUsd ?? opts.cash_usd ?? Infinity);
  const budgetRemainingUsd = Number(
    opts.budgetRemainingUsd ?? opts.budget_remaining_usd ?? policy.daily_budget_usd
  );
  const tradesUsed = Number(opts.tradesUsed ?? opts.trades_used ?? 0);
  const positions = opts.positions || [];
  const pendingSellSymbols = new Set(
    (opts.pendingSellSymbols || opts.pending_sell_symbols || []).map((s) => String(s).toUpperCase())
  );
  const blockDuplicateBuys =
    opts.blockDuplicateBuys != null
      ? opts.blockDuplicateBuys !== false
      : policy.block_duplicate_buys !== false;
  const minRationale = Number(
    opts.minRationaleChars ?? opts.min_rationale_chars ?? policy.min_rationale_chars
  );

  const { ok: parsedOk, error: parseError, plan } = parseTradePlan(planInput);
  if (!parsedOk) return { ok: false, error: parseError, trades_to_place: [], residual: [], spendable_usd: 0 };

  const trades = Array.isArray(plan.trades) ? plan.trades : Array.isArray(plan) ? plan : [];
  if (!trades.length) {
    const residualOnly = Array.isArray(plan.residual) ? plan.residual : [];
    const notes = String(plan.notes || '').trim();
    if (notes || residualOnly.length) {
      return {
        ok: true,
        error: null,
        errors: [],
        trades_to_place: [],
        residual: residualOnly,
        spendable_usd: Number(Math.max(0, Math.min(budgetRemainingUsd, cashUsd)).toFixed(2)),
        reserved_usd: 0,
        slots_left: Math.max(
          0,
          Number(opts.maxTradesPerDay ?? opts.max_trades_per_day ?? policy.max_trades_per_day) - tradesUsed
        ),
        us_only_fallback_hint: false,
        allowlist_keys: allowlistKeys,
        allowlist: catalog,
        no_trade_day: true,
        config: {
          daily_budget_usd: policy.daily_budget_usd,
          max_trades_per_day: policy.max_trades_per_day,
          stop_pct: [policy.stop_pct_min, policy.stop_pct_max],
          tp_pct: [policy.tp_pct_min, policy.tp_pct_max],
          min_rationale_chars: minRationale,
        },
      };
    }
    return { ok: false, error: 'Plan has no trades[]', trades_to_place: [], residual: [], spendable_usd: 0 };
  }

  const spendable = Math.max(0, Math.min(budgetRemainingUsd, cashUsd));
  const maxTrades = Number(opts.maxTradesPerDay ?? opts.max_trades_per_day ?? policy.max_trades_per_day);
  const slotsLeft = Math.max(0, maxTrades - tradesUsed);
  const held = new Set(
    (positions || []).map((p) => String(p.symbol || p.key || '').toUpperCase()).filter(Boolean)
  );
  for (const p of positions || []) {
    const meta = findAllowlistEntry(p.key || p.symbol, catalog);
    if (meta) {
      held.add(meta.key);
      held.add(meta.symbol);
    }
  }

  const errors = [];
  const normalized = [];
  let runningSpend = 0;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i] || {};
    const entryMeta = findAllowlistEntry(t.key || t.symbol || t.ticker, catalog);
    if (!entryMeta || !allowlistKeys.includes(entryMeta.key)) {
      errors.push(`Trade ${i + 1}: symbol not on allowlist (${t.key || t.symbol})`);
      continue;
    }

    const side = String(t.side || '').toUpperCase().replace(/-/g, '_');
    if (side !== 'BUY' && side !== 'SELL_TO_CLOSE') {
      errors.push(`Trade ${i + 1}: side must be BUY or SELL_TO_CLOSE`);
      continue;
    }
    if (side === 'SELL_TO_CLOSE') {
      const hasPos =
        held.has(entryMeta.symbol) ||
        held.has(entryMeta.key) ||
        (Number(t.qty || 0) > 0 && opts.allowSellWithoutPositionCheck);
      if (!hasPos && !opts.allowSellWithoutPositionCheck) {
        errors.push(`Trade ${i + 1}: SELL_TO_CLOSE requires open long in ${entryMeta.key}`);
        continue;
      }
      if (pendingSellSymbols.has(entryMeta.symbol) || pendingSellSymbols.has(entryMeta.key)) {
        errors.push(`Trade ${i + 1}: pending SELL already exists for ${entryMeta.key}`);
        continue;
      }
    }
    if (side === 'BUY' && blockDuplicateBuys) {
      if (held.has(entryMeta.symbol) || held.has(entryMeta.key)) {
        errors.push(`Trade ${i + 1}: already long ${entryMeta.key} — skip duplicate BUY`);
        continue;
      }
    }

    const ref = Number(t.reference_price ?? t.ref_price ?? t.last ?? 0);
    const entry = Number(t.entry_price ?? t.price ?? 0);
    const qty = Number(t.qty ?? t.quantity ?? 0);
    const stopPct = Number(t.stop_pct ?? t.stopLossPct ?? 0);
    const tpPct = Number(t.tp_pct ?? t.take_profit_pct ?? t.takeProfitPct ?? 0);
    const rationale = String(t.rationale || t.justification || '').trim();
    const thesis = String(t.thesis || '').trim();
    const catalysts = String(t.catalysts || '').trim();
    const risks = String(t.risks || '').trim();
    const whyNow = String(t.why_now || t.whyNow || '').trim();
    const combinedJustification = [rationale, thesis, catalysts, risks, whyNow].filter(Boolean).join(' | ');

    if (!(ref > 0) || !(entry > 0) || !(qty > 0)) {
      errors.push(`Trade ${i + 1}: reference_price, entry_price, qty required`);
      continue;
    }
    if (!isQtyMultipleOfLot(qty, entryMeta.boardLot)) {
      errors.push(
        `Trade ${i + 1}: qty must be a multiple of board_lot ${entryMeta.boardLot} for ${entryMeta.key} (got ${qty})`
      );
      continue;
    }
    if (side === 'BUY') {
      const maxEntry = ref * (1 + policy.entry_slip_pct_max / 100);
      if (entry > maxEntry + 1e-9) {
        errors.push(`Trade ${i + 1}: entry ${entry} exceeds +${policy.entry_slip_pct_max}% of ref ${ref}`);
        continue;
      }
      if (stopPct < policy.stop_pct_min || stopPct > policy.stop_pct_max) {
        errors.push(`Trade ${i + 1}: stop_pct must be ${policy.stop_pct_min}-${policy.stop_pct_max}`);
        continue;
      }
      if (tpPct < policy.tp_pct_min || tpPct > policy.tp_pct_max) {
        errors.push(`Trade ${i + 1}: tp_pct must be ${policy.tp_pct_min}-${policy.tp_pct_max}`);
        continue;
      }
      if (!thesis || !risks || !whyNow) {
        errors.push(`Trade ${i + 1}: BUY requires thesis, risks, and why_now for checker`);
        continue;
      }
    }
    if (!combinedJustification || combinedJustification.length < minRationale) {
      errors.push(
        `Trade ${i + 1}: justification too short (need ≥${minRationale} chars across rationale/thesis/catalysts/risks/why_now)`
      );
      continue;
    }

    const notionalNative = entry * qty;
    const notionalUsd = side === 'BUY' ? toUsd(notionalNative, entryMeta.currency, policy.sgd_usd_rate) : 0;
    const stopPrice =
      side === 'BUY' ? entry * (1 - stopPct / 100) : entry * (1 + (stopPct || 0) / 100);
    const tpPrice = side === 'BUY' ? entry * (1 + tpPct / 100) : entry * (1 - (tpPct || 0) / 100);
    const priceDecimals = entryMeta.secType === 'CRYPTO' ? 2 : 4;
    const roundTick = (p) =>
      entryMeta.secType === 'CRYPTO' ? Math.round(Number(p) * 4) / 4 : Number(Number(p).toFixed(priceDecimals));

    normalized.push({
      key: entryMeta.key,
      symbol: entryMeta.symbol,
      exchange: entryMeta.exchange,
      market: entryMeta.market,
      currency: entryMeta.currency,
      secType: entryMeta.secType || 'STK',
      side,
      qty,
      reference_price: roundTick(ref),
      entry_price: roundTick(entry),
      stop_pct: side === 'BUY' ? clamp(stopPct, policy.stop_pct_min, policy.stop_pct_max) : stopPct,
      tp_pct: side === 'BUY' ? clamp(tpPct, policy.tp_pct_min, policy.tp_pct_max) : tpPct,
      stop_price: roundTick(stopPrice),
      tp_price: roundTick(tpPrice),
      notional_native: Number(notionalNative.toFixed(2)),
      notional_usd: Number(notionalUsd.toFixed(2)),
      rationale: combinedJustification,
      thesis,
      catalysts,
      risks,
      why_now: whyNow,
      board_lot: entryMeta.boardLot,
    });
  }

  const usOnlyFallbackHint = errors.some((e) => /for SGX:/i.test(String(e)));

  const placeable = [];
  const residual = [];
  for (const t of normalized) {
    if (placeable.length >= slotsLeft) {
      residual.push({ ...t, residual_reason: 'max_trades_per_day' });
      continue;
    }
    if (t.side === 'BUY') {
      if (runningSpend + t.notional_usd > spendable + 1e-6) {
        residual.push({ ...t, residual_reason: 'budget_or_cash' });
        continue;
      }
      runningSpend += t.notional_usd;
    }
    placeable.push(t);
  }

  // SG board-lot misses are non-blocking so US/CRYPTO legs can still place
  const blockingErrors = errors.filter((e) => !/for SGX:/i.test(String(e)));
  return {
    ok: blockingErrors.length === 0,
    error: errors.length ? errors.join('; ') : null,
    errors,
    trades_to_place: placeable,
    residual: [...residual, ...(Array.isArray(plan.residual) ? plan.residual : [])],
    spendable_usd: Number(spendable.toFixed(2)),
    reserved_usd: Number(runningSpend.toFixed(2)),
    slots_left: slotsLeft,
    us_only_fallback_hint: usOnlyFallbackHint,
    allowlist_keys: allowlistKeys,
    allowlist: catalog,
    config: {
      daily_budget_usd: policy.daily_budget_usd,
      max_trades_per_day: policy.max_trades_per_day,
      stop_pct: [policy.stop_pct_min, policy.stop_pct_max],
      tp_pct: [policy.tp_pct_min, policy.tp_pct_max],
      min_rationale_chars: minRationale,
    },
  };
}

export function validateTradePlanStrict(planInput, opts = {}) {
  return validateTradePlan(planInput, opts);
}
