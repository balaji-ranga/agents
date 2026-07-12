/**
 * IBKR workflow variable helpers.
 *
 * Tradable instruments and trading policy live on the workflow definition
 * (`variables_json` / Variables panel) — not in this module and not in .env.
 *
 * This file only normalizes/resolves whatever the workflow supplies.
 */

/** Soft numeric defaults only when a workflow omits a policy key (never tickers). */
export const IBKR_POLICY_DEFAULTS = Object.freeze({
  daily_budget_usd: 1000,
  max_trades_per_day: 10,
  checker_max_loops: 3,
  min_rationale_chars: 80,
  block_duplicate_buys: true,
  require_live_cash: true,
  max_hold_days: 5,
  max_hold_extension_days: 2,
  stop_pct_min: 1.5,
  stop_pct_max: 2.0,
  tp_pct_min: 0.5,
  tp_pct_max: 2.0,
  entry_slip_pct_max: 0.25,
  no_margin: true,
  sgd_usd_rate: 0.74,
  on_review_fail: 'hold',
  poll_interval_cron: '*/15 * * * *',
  require_ceo_on_exit: false,
});

export function normalizeInstrument(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const symbol = String(entry.symbol || '').trim().toUpperCase();
  const exchange = String(entry.exchange || '').trim().toUpperCase();
  const key = String(entry.key || (exchange && symbol ? `${exchange}:${symbol}` : symbol))
    .trim()
    .toUpperCase();
  if (!key || !symbol) return null;
  const boardLot = Number(entry.board_lot ?? entry.boardLot ?? 1);
  const secType = String(entry.sec_type || entry.secType || 'STK').trim().toUpperCase() || 'STK';
  const market = String(entry.market || (secType === 'CRYPTO' ? 'CRYPTO' : 'US'))
    .trim()
    .toUpperCase();
  const currency = String(entry.currency || 'USD').trim().toUpperCase() || 'USD';
  return {
    key,
    symbol,
    exchange: exchange || (secType === 'CRYPTO' ? 'PAXOS' : 'SMART'),
    market,
    currency,
    boardLot: Number.isFinite(boardLot) && boardLot > 0 ? boardLot : 1,
    board_lot: Number.isFinite(boardLot) && boardLot > 0 ? boardLot : 1,
    secType,
    sec_type: secType,
  };
}

/**
 * Normalize workflow `allowlist` into instrument records.
 * No hardcoded ticker fallback — empty input → empty list.
 * String keys are only kept if they already appear as full objects in the same array
 * (or as EXCHANGE:SYMBOL with enough parts to infer STK defaults).
 */
export function normalizeAllowlist(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];

  const objects = [];
  const stringKeys = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      stringKeys.push(item.trim().toUpperCase());
      continue;
    }
    if (item && typeof item === 'object') {
      const norm = normalizeInstrument(item);
      if (norm) objects.push(norm);
    }
  }

  if (!stringKeys.length) return objects;

  const byKey = new Map(objects.map((a) => [a.key, a]));
  const out = [...objects];
  for (const key of stringKeys) {
    if (byKey.has(key)) continue;
    // Infer minimal meta from KEY shape EXCHANGE:SYMBOL (workflow should prefer full objects)
    const parts = key.split(':');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const inferred = normalizeInstrument({
        key,
        exchange: parts[0],
        symbol: parts.slice(1).join(':'),
        market: parts[0] === 'PAXOS' ? 'CRYPTO' : parts[0] === 'SGX' ? 'SG' : 'US',
        currency: parts[0] === 'SGX' ? 'SGD' : 'USD',
        board_lot: parts[0] === 'SGX' ? 100 : parts[0] === 'PAXOS' ? 0.0001 : 1,
        sec_type: parts[0] === 'PAXOS' ? 'CRYPTO' : 'STK',
      });
      if (inferred) {
        out.push(inferred);
        byKey.set(inferred.key, inferred);
      }
    }
  }
  return out;
}

export function allowlistKeysFrom(allowlist) {
  return normalizeAllowlist(allowlist).map((a) => a.key);
}

export function findInAllowlist(symbolOrKey, catalog) {
  const raw = String(symbolOrKey || '').trim().toUpperCase();
  if (!raw) return null;
  const list = normalizeAllowlist(catalog || []);
  return (
    list.find((a) => a.key === raw) ||
    list.find((a) => a.symbol === raw) ||
    list.find((a) => raw.endsWith(`:${a.symbol}`)) ||
    null
  );
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback) {
  if (v === true || v === false) return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

/**
 * Resolve trading policy from a workflow's variables object.
 * Allowlist comes only from vars.allowlist (or vars.allowlist_keys as EXCHANGE:SYMBOL strings).
 */
export function resolveIbkrPolicy(variables = {}) {
  const vars = variables && typeof variables === 'object' ? variables : {};
  const d = IBKR_POLICY_DEFAULTS;
  const allowlist = normalizeAllowlist(vars.allowlist || vars.allowlist_keys || []);
  const markets = Array.isArray(vars.markets)
    ? vars.markets.map((m) => String(m).toUpperCase())
    : [...new Set(allowlist.map((a) => a.market))];

  return {
    markets,
    allowlist,
    allowlist_keys: allowlist.map((a) => a.key),
    daily_budget_usd: num(vars.daily_budget_usd, d.daily_budget_usd),
    max_trades_per_day: num(vars.max_trades_per_day, d.max_trades_per_day),
    checker_max_loops: num(vars.checker_max_loops, d.checker_max_loops),
    min_rationale_chars: num(vars.min_rationale_chars, d.min_rationale_chars),
    block_duplicate_buys: bool(vars.block_duplicate_buys, d.block_duplicate_buys),
    require_live_cash: bool(vars.require_live_cash, d.require_live_cash),
    max_hold_days: num(vars.max_hold_days, d.max_hold_days),
    max_hold_extension_days: num(vars.max_hold_extension_days, d.max_hold_extension_days),
    stop_pct_min: num(vars.stop_pct_min, d.stop_pct_min),
    stop_pct_max: num(vars.stop_pct_max, d.stop_pct_max),
    tp_pct_min: num(vars.tp_pct_min, d.tp_pct_min),
    tp_pct_max: num(vars.tp_pct_max, d.tp_pct_max),
    entry_slip_pct_max: num(vars.entry_slip_pct_max, d.entry_slip_pct_max),
    no_margin: bool(vars.no_margin, d.no_margin),
    sgd_usd_rate: num(vars.sgd_usd_rate, d.sgd_usd_rate),
    on_review_fail: String(vars.on_review_fail || d.on_review_fail),
    poll_interval_cron: String(vars.poll_interval_cron || d.poll_interval_cron),
    require_ceo_on_exit: bool(vars.require_ceo_on_exit, d.require_ceo_on_exit),
  };
}

/** Ensure allowlist_keys stays in sync with allowlist objects (for prompts). */
export function withDerivedAllowlistKeys(variables = {}) {
  const policy = resolveIbkrPolicy(variables);
  return {
    ...variables,
    markets: policy.markets,
    allowlist: policy.allowlist,
    allowlist_keys: policy.allowlist_keys,
  };
}
