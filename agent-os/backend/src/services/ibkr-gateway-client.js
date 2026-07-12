/**
 * Direct IB Gateway / TWS socket client for paper bracket placement.
 * Uses @stoqey/ib — does not require MCP for order submission.
 */
import { IBApi, EventName, OrderType, OrderAction, SecType, TimeInForce } from '@stoqey/ib';
import { getIbkrTradingConfig } from './ibkr-trading-rules.js';
import { normalizeAllowlist } from './ibkr-workflow-variables.js';

function gatewayOptions() {
  return {
    host: process.env.IBKR_HOST || '127.0.0.1',
    port: Number(process.env.IBKR_PORT || 4002),
    clientId: Number(process.env.IBKR_CLIENT_ID || 17),
  };
}

function assertPaperSafe({ requireTradingEnabled = true } = {}) {
  const cfg = getIbkrTradingConfig();
  if (!cfg.isPaper && process.env.IBKR_ALLOW_LIVE !== '1') {
    throw new Error('Refusing non-paper IBKR orders — set IBKR_IS_PAPER=true or IBKR_ALLOW_LIVE=1');
  }
  if (requireTradingEnabled && !cfg.tradingEnabled) {
    throw new Error('IBKR_TRADING_ENABLED is off');
  }
}

function toContract(trade) {
  const symbol = String(trade.symbol || '').toUpperCase();
  const currency = String(trade.currency || 'USD').toUpperCase();
  const exchange = String(trade.exchange || '').toUpperCase();
  const secTypeRaw = String(trade.secType || trade.sec_type || '').toUpperCase();
  const isCrypto = secTypeRaw === 'CRYPTO' || exchange === 'PAXOS' || symbol === 'BTC';

  if (isCrypto) {
    return {
      symbol,
      secType: SecType.CRYPTO,
      exchange: exchange || 'PAXOS',
      currency: currency || 'USD',
    };
  }

  const primary = exchange === 'BATS' ? 'BATS' : exchange === 'SGX' ? 'SGX' : exchange || undefined;
  return {
    symbol,
    secType: SecType.STK,
    exchange: exchange === 'SGX' ? 'SGX' : 'SMART',
    primaryExch: primary && primary !== 'SMART' ? primary : undefined,
    currency,
  };
}

function roundPrice(n, secType = 'STK') {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  // PAXOS crypto typically uses 0.25 USD ticks
  if (String(secType).toUpperCase() === 'CRYPTO') {
    return Math.round(x * 4) / 4;
  }
  return Math.round(x * 100) / 100;
}

/**
 * Connect briefly, run fn(ib, { nextId, account }), disconnect.
 */
export async function withIbGateway(fn, { timeoutMs = 45000, requireTradingEnabled = true } = {}) {
  assertPaperSafe({ requireTradingEnabled });
  const opts = gatewayOptions();
  const ib = new IBApi(opts);

  return new Promise((resolve, reject) => {
    let settled = false;
    let nextId = null;
    let account = process.env.IBKR_ACCOUNT_ID || null;
    const timer = setTimeout(() => {
      cleanup(new Error(`IB Gateway timeout after ${timeoutMs}ms (${opts.host}:${opts.port})`));
    }, timeoutMs);

    const cleanup = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ib.disconnect();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value);
    };

    ib.on(EventName.error, (err, code, reqId) => {
      const msg = err?.message || String(err);
      // Informational / market-data soft codes — ignore
      if ([2104, 2106, 2158, 2119, 10090, 10167, 354, 300].includes(Number(code))) return;
      if (settled) return;
      // Hard failures during connect / place
      if (Number(code) >= 500 || Number(reqId) === -1) {
        cleanup(new Error(`IB error ${code}: ${msg}`));
      }
    });

    ib.on(EventName.connected, () => {
      ib.reqIds();
      if (!account) ib.reqManagedAccts();
    });

    ib.on(EventName.managedAccounts, (accountsList) => {
      if (!account && accountsList) {
        account = String(accountsList).split(',')[0]?.trim() || null;
      }
    });

    ib.once(EventName.nextValidId, async (id) => {
      nextId = id;
      try {
        // brief wait for managed accounts if needed
        if (!account) {
          await new Promise((r) => setTimeout(r, 500));
        }
        const result = await fn(ib, { nextId, account, opts });
        cleanup(null, result);
      } catch (e) {
        cleanup(e);
      }
    });

    try {
      ib.connect();
    } catch (e) {
      cleanup(e);
    }
  });
}

/**
 * After openOrder ack, briefly watch orderStatus/error for immediate cancel/reject.
 * @returns {Promise<{ terminal_cancelled?: boolean, terminal_status?: string, terminal_reason_text?: string, terminal_reason_code?: string, error_code?: number }>}
 */
function watchOrderTerminal(ib, orderIds, { watchMs = 8000 } = {}) {
  const ids = new Set((orderIds || []).map(Number).filter(Number.isFinite));
  if (!ids.size || watchMs <= 0) return Promise.resolve({});

  return new Promise((resolve) => {
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      ib.off(EventName.orderStatus, onStatus);
      ib.off(EventName.error, onErr);
      resolve(payload || {});
    };
    const t = setTimeout(() => finish({}), watchMs);

    const onStatus = (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld) => {
      if (!ids.has(Number(orderId))) return;
      const st = String(status || '');
      if (/Cancelled|Inactive|ApiCancelled/i.test(st)) {
        finish({
          terminal_cancelled: true,
          terminal_status: st,
          terminal_reason_text: whyHeld ? String(whyHeld) : `IB orderStatus=${st}`,
          terminal_reason_code: 'ib_system_cancel',
        });
      } else if (/Filled/i.test(st) && Number(remaining) === 0) {
        finish({
          terminal_cancelled: false,
          terminal_status: 'Filled',
          terminal_reason_text: 'Filled during post-ack watch',
          terminal_reason_code: 'filled',
        });
      }
    };

    const onErr = (err, code, reqId) => {
      if (!ids.has(Number(reqId))) return;
      if ([2104, 2106, 2158, 2119, 10090, 10167, 354, 300].includes(Number(code))) return;
      const msg = err?.message || String(err);
      finish({
        terminal_cancelled: true,
        terminal_status: 'Rejected',
        terminal_reason_text: msg,
        terminal_reason_code: 'place_rejected_ib',
        error_code: Number(code) || null,
      });
    };

    ib.on(EventName.orderStatus, onStatus);
    ib.on(EventName.error, onErr);
  });
}

/**
 * Place a BUY bracket (entry LMT + TP LMT + SL STP) or plain SELL_TO_CLOSE LMT.
 * @returns {{ orderIds: number[], account: string, key: string, side: string }}
 */
export async function placeBracketTrade(trade, { postAckWatchMs = 0, cancelSource = 'before_sell' } = {}) {
  const side = String(trade.side || 'BUY').toUpperCase();
  const qty = Number(trade.qty);
  if (!qty || qty <= 0) throw new Error(`Invalid qty for ${trade.key || trade.symbol}`);
  const secType = String(trade.secType || trade.sec_type || '').toUpperCase();
  const isCrypto =
    secType === 'CRYPTO' ||
    String(trade.exchange || '').toUpperCase() === 'PAXOS' ||
    String(trade.symbol || '').toUpperCase() === 'BTC' ||
    String(trade.symbol || '').toUpperCase() === 'ETH';

  if (side === 'SELL_TO_CLOSE' || side === 'SELL') {
    try {
      await cancelOpenOrdersForSymbol(trade.symbol || trade.key?.split(':')?.pop(), {
        cancelSource: trade.cancel_source || cancelSource || 'before_sell',
        ownerUserId: trade.owner_user_id || null,
        symbolKey: trade.key || null,
      });
    } catch {
      /* best-effort */
    }
    return withIbGateway(async (ib, { nextId, account }) => {
      if (!account) throw new Error('No IBKR account id');
      const contract = toContract(trade);
      const oid = nextId;
      const order = {
        orderId: oid,
        action: OrderAction.SELL,
        orderType: OrderType.LMT,
        totalQuantity: qty,
        lmtPrice: roundPrice(trade.entry_price ?? trade.reference_price, isCrypto ? 'CRYPTO' : secType),
        // Crypto LMT supports IOC or Minutes (not DAY)
        tif: isCrypto ? TimeInForce.Minutes : TimeInForce.DAY,
        account,
        transmit: true,
        outsideRth: false,
      };
      const ack = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`No openOrder ack for order ${oid}`)), 15000);
        const onOpen = (id) => {
          if (id === oid) {
            clearTimeout(t);
            ib.off(EventName.openOrder, onOpen);
            ib.off(EventName.error, onErr);
            resolve();
          }
        };
        const onErr = (err, code, reqId) => {
          if (reqId === oid && ![2104, 2106, 2158, 10090].includes(Number(code))) {
            clearTimeout(t);
            ib.off(EventName.openOrder, onOpen);
            ib.off(EventName.error, onErr);
            reject(new Error(`Order ${oid} rejected (${code}): ${err?.message || err}`));
          }
        };
        ib.on(EventName.openOrder, onOpen);
        ib.on(EventName.error, onErr);
      });
      ib.placeOrder(oid, contract, order);
      await ack;
      const terminal = await watchOrderTerminal(ib, [oid], { watchMs: postAckWatchMs });
      return { orderIds: [oid], account, key: trade.key, side, contract, ...terminal };
    });
  }

  // CRYPTO: IBKR supports LMT/MKT only (no stock-style STP brackets). Place entry LMT.
  if (isCrypto) {
    return withIbGateway(async (ib, { nextId, account }) => {
      if (!account) throw new Error('No IBKR account id (set IBKR_ACCOUNT_ID or wait for managedAccounts)');
      const contract = toContract(trade);
      const oid = nextId;
      const entry = roundPrice(trade.entry_price, 'CRYPTO');
      const order = {
        orderId: oid,
        action: OrderAction.BUY,
        orderType: OrderType.LMT,
        totalQuantity: qty,
        lmtPrice: entry,
        tif: TimeInForce.Minutes,
        account,
        transmit: true,
        outsideRth: false,
      };
      const ack = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`No openOrder ack for order ${oid}`)), 20000);
        const onOpen = (id) => {
          if (id === oid) {
            clearTimeout(t);
            ib.off(EventName.openOrder, onOpen);
            ib.off(EventName.error, onErr);
            resolve();
          }
        };
        const onErr = (err, code, reqId) => {
          if (reqId === oid && ![2104, 2106, 2158, 10090].includes(Number(code))) {
            clearTimeout(t);
            ib.off(EventName.openOrder, onOpen);
            ib.off(EventName.error, onErr);
            reject(new Error(`Order ${oid} rejected (${code}): ${err?.message || err}`));
          }
        };
        ib.on(EventName.openOrder, onOpen);
        ib.on(EventName.error, onErr);
      });
      ib.placeOrder(oid, contract, order);
      await ack;
      const terminal = await watchOrderTerminal(ib, [oid], { watchMs: postAckWatchMs || 8000 });
      return {
        orderIds: [oid],
        account,
        key: trade.key,
        side: 'BUY',
        contract,
        entry,
        take_profit: trade.tp_price != null ? roundPrice(trade.tp_price, 'CRYPTO') : null,
        stop: trade.stop_price != null ? roundPrice(trade.stop_price, 'CRYPTO') : null,
        note: 'CRYPTO entry LMT only (Minutes TIF); STP brackets not supported — exits via poller/SELL_TO_CLOSE',
        ...terminal,
      };
    });
  }

  return withIbGateway(async (ib, { nextId, account }) => {
    if (!account) throw new Error('No IBKR account id (set IBKR_ACCOUNT_ID or wait for managedAccounts)');
    const contract = toContract(trade);
    let orderId = nextId;
    const orderIds = [];

    const waitAck = (oid) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`No openOrder ack for order ${oid}`)), 15000);
        const onOpen = (id) => {
          if (id === oid) {
            clearTimeout(t);
            ib.off(EventName.openOrder, onOpen);
            ib.off(EventName.error, onErr);
            resolve();
          }
        };
        const onErr = (err, code, reqId) => {
          if (reqId === oid && ![2104, 2106, 2158].includes(Number(code))) {
            clearTimeout(t);
            ib.off(EventName.openOrder, onOpen);
            ib.off(EventName.error, onErr);
            reject(new Error(`Order ${oid} rejected (${code}): ${err?.message || err}`));
          }
        };
        ib.on(EventName.openOrder, onOpen);
        ib.on(EventName.error, onErr);
      });

    // BUY bracket (equities)
    const parentId = orderId++;
    const tpId = orderId++;
    const slId = orderId++;
    orderIds.push(parentId, tpId, slId);

    const entry = roundPrice(trade.entry_price, secType);
    const tp = roundPrice(trade.tp_price, secType);
    const stop = roundPrice(trade.stop_price, secType);

    const parent = {
      orderId: parentId,
      action: OrderAction.BUY,
      orderType: OrderType.LMT,
      totalQuantity: qty,
      lmtPrice: entry,
      tif: TimeInForce.DAY,
      account,
      transmit: false,
      outsideRth: false,
    };
    const takeProfit = {
      orderId: tpId,
      action: OrderAction.SELL,
      orderType: OrderType.LMT,
      totalQuantity: qty,
      lmtPrice: tp,
      tif: TimeInForce.GTC,
      account,
      parentId,
      transmit: false,
      outsideRth: false,
    };
    const stopLoss = {
      orderId: slId,
      action: OrderAction.SELL,
      orderType: OrderType.STP,
      totalQuantity: qty,
      auxPrice: stop,
      tif: TimeInForce.GTC,
      account,
      parentId,
      transmit: true,
      outsideRth: false,
    };

    const ackParent = waitAck(parentId);
    ib.placeOrder(parentId, contract, parent);
    ib.placeOrder(tpId, contract, takeProfit);
    ib.placeOrder(slId, contract, stopLoss);
    await ackParent;
    await new Promise((r) => setTimeout(r, 800));
    const terminal = await watchOrderTerminal(ib, [parentId], { watchMs: postAckWatchMs });

    return {
      orderIds,
      account,
      key: trade.key,
      side: 'BUY',
      contract,
      entry,
      take_profit: tp,
      stop,
      ...terminal,
    };
  });
}

/** Place many trades sequentially; returns per-trade results. */
export async function placeBracketTrades(trades = [], opts = {}) {
  const results = [];
  for (const trade of trades) {
    try {
      const placed = await placeBracketTrade(
        { ...trade, owner_user_id: trade.owner_user_id || opts.ownerUserId },
        {
          postAckWatchMs: opts.postAckWatchMs ?? 8000,
          cancelSource: trade.cancel_source || opts.cancelSource || 'before_sell',
        }
      );
      results.push({ ok: true, ...placed });
    } catch (e) {
      results.push({
        ok: false,
        key: trade.key,
        error: e.message || String(e),
      });
    }
  }
  // ok if every trade either placed successfully OR was ack'd then IB-cancelled (ledger handles release)
  const ok = results.every((r) => r.ok);
  return { ok, results };
}

export async function pingIbGateway() {
  return withIbGateway(
    async (_ib, ctx) => ({
      ok: true,
      account: ctx.account,
      nextId: ctx.nextId,
      host: ctx.opts.host,
      port: ctx.opts.port,
    }),
    { requireTradingEnabled: false }
  );
}

function cashFromSummary(summary = {}) {
  const prefer = ['TotalCashValue', 'AvailableFunds', 'NetLiquidation'];
  for (const tag of prefer) {
    const n = Number(summary[tag]?.value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Snapshot mid/last prices for allowlist instruments (needed for maker reference_price).
 * Uses delayed market data type when live is unavailable.
 */
async function fetchReferenceQuotes(ib, instruments = []) {
  const list = normalizeAllowlist(instruments);
  const reference_prices = {};
  let reqId = 9200;

  // Prefer delayed if no live crypto subscription
  try {
    ib.reqMarketDataType(3);
  } catch {
    /* ignore */
  }

  for (const inst of list) {
    const contract = toContract({
      symbol: inst.symbol,
      exchange: inst.exchange,
      currency: inst.currency,
      secType: inst.secType,
    });
    const id = reqId++;
    const price = await new Promise((resolve) => {
      let last = null;
      let bid = null;
      let ask = null;
      let close = null;
      const finish = (value) => {
        clearTimeout(timer);
        ib.off(EventName.tickPrice, onTick);
        try {
          ib.cancelMktData(id);
        } catch {
          /* ignore */
        }
        resolve(value);
      };
      const timer = setTimeout(() => {
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
        finish(last || mid || close || null);
      }, 6000);
      const onTick = (tickerId, field, p) => {
        if (tickerId !== id || !(Number(p) > 0)) return;
        const n = Number(p);
        // LAST / DELAYED_LAST / MARK
        if (field === 4 || field === 68 || field === 37) last = n;
        if (field === 1 || field === 66) bid = n;
        if (field === 2 || field === 67) ask = n;
        if (field === 9 || field === 75) close = n;
        if (last > 0 || (bid > 0 && ask > 0)) {
          finish(last || (bid + ask) / 2);
        }
      };
      ib.on(EventName.tickPrice, onTick);
      try {
        ib.reqMktData(id, contract, '', false, false);
      } catch {
        finish(null);
      }
    });

    if (Number(price) > 0) {
      reference_prices[inst.key] = {
        key: inst.key,
        symbol: inst.symbol,
        exchange: inst.exchange,
        market: inst.market,
        currency: inst.currency,
        sec_type: inst.secType,
        reference_price: Number(Number(price).toFixed(inst.secType === 'CRYPTO' ? 2 : 4)),
        source: 'ibkr_mkt_data',
      };
    }
  }
  return reference_prices;
}

/** Fallback USD spots for crypto when IBKR market data is not subscribed. */
async function enrichCryptoReferencePrices(instruments = [], existing = {}) {
  const out = { ...existing };
  const list = normalizeAllowlist(instruments).filter(
    (i) => i.secType === 'CRYPTO' || i.market === 'CRYPTO'
  );
  for (const inst of list) {
    if (out[inst.key]?.reference_price > 0) continue;
    const pair = `${inst.symbol}USDT`;
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const price = Number(body?.price);
      if (!(price > 0)) continue;
      out[inst.key] = {
        key: inst.key,
        symbol: inst.symbol,
        exchange: inst.exchange,
        market: inst.market,
        currency: inst.currency,
        sec_type: inst.secType,
        reference_price: Number(price.toFixed(2)),
        source: 'binance_public',
      };
    } catch {
      /* ignore per-symbol */
    }
  }
  return out;
}

/**
 * Live paper/live book snapshot: cash, positions, open orders, pending sells.
 * @param {{ timeoutMs?: number, allowlist?: Array }} opts
 */
export async function fetchAccountSnapshot({ timeoutMs = 90000, allowlist = null } = {}) {
  return withIbGateway(
    async (ib, { account }) => {
      const summary = {};
      const positions = [];
      const openOrders = [];

      await new Promise((resolve, reject) => {
        const reqId = 9101;
        const t = setTimeout(() => reject(new Error('accountSummary timeout')), 20000);
        const onSum = (id, acct, tag, value, currency) => {
          if (id !== reqId) return;
          summary[tag] = { value, currency, account: acct };
        };
        const onEnd = (id) => {
          if (id !== reqId) return;
          clearTimeout(t);
          ib.off(EventName.accountSummary, onSum);
          ib.off(EventName.accountSummaryEnd, onEnd);
          resolve();
        };
        ib.on(EventName.accountSummary, onSum);
        ib.on(EventName.accountSummaryEnd, onEnd);
        ib.reqAccountSummary(reqId, 'All', 'TotalCashValue,AvailableFunds,NetLiquidation,BuyingPower');
      });

      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);
        const onPos = (acct, contract, pos, avgCost) => {
          if (!contract?.symbol || Number(pos) === 0) return;
          positions.push({
            account: acct,
            symbol: contract.symbol,
            exchange: contract.primaryExch || contract.exchange || '',
            currency: contract.currency || 'USD',
            qty: Number(pos),
            avg_cost: avgCost != null ? Number(avgCost) : null,
            sec_type: contract.secType,
          });
        };
        const onEnd = () => {
          clearTimeout(t);
          ib.off(EventName.position, onPos);
          ib.off(EventName.positionEnd, onEnd);
          resolve();
        };
        ib.on(EventName.position, onPos);
        ib.on(EventName.positionEnd, onEnd);
        ib.reqPositions();
      });

      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);
        const onOpen = (orderId, contract, order, orderState) => {
          openOrders.push({
            order_id: orderId,
            symbol: contract?.symbol || '',
            exchange: contract?.primaryExch || contract?.exchange || '',
            action: order?.action || '',
            order_type: order?.orderType || '',
            qty: order?.totalQuantity != null ? Number(order.totalQuantity) : null,
            lmt_price: order?.lmtPrice,
            aux_price: order?.auxPrice,
            parent_id: order?.parentId || 0,
            status: orderState?.status || '',
            warning_text: orderState?.warningText || orderState?.completedStatus || null,
            why_held: orderState?.whyHeld || null,
          });
        };
        const onEnd = () => {
          clearTimeout(t);
          ib.off(EventName.openOrder, onOpen);
          ib.off(EventName.openOrderEnd, onEnd);
          resolve();
        };
        ib.on(EventName.openOrder, onOpen);
        ib.on(EventName.openOrderEnd, onEnd);
        ib.reqAllOpenOrders();
      });

      let reference_prices = {};
      if (Array.isArray(allowlist) && allowlist.length) {
        const catalog = normalizeAllowlist(allowlist);
        const equity = catalog.filter((i) => i.secType !== 'CRYPTO' && i.market !== 'CRYPTO');
        const crypto = catalog.filter((i) => i.secType === 'CRYPTO' || i.market === 'CRYPTO');
        if (equity.length) {
          try {
            reference_prices = await fetchReferenceQuotes(ib, equity);
          } catch {
            /* ignore */
          }
        }
        // Crypto MD often unsubscribed on paper — use public USD spots
        reference_prices = await enrichCryptoReferencePrices(crypto, reference_prices);
      }

      const pendingSells = openOrders.filter((o) => String(o.action).toUpperCase() === 'SELL');
      const cashUsd = cashFromSummary(summary);
      return {
        ok: true,
        account,
        cash_usd: cashUsd,
        summary,
        positions,
        open_orders: openOrders,
        pending_sells: pendingSells,
        pending_sell_symbols: [...new Set(pendingSells.map((o) => String(o.symbol).toUpperCase()).filter(Boolean))],
        reference_prices,
        captured_at: new Date().toISOString(),
      };
    },
    { requireTradingEnabled: false, timeoutMs }
  );
}

/** Cancel all open orders (paper cleanup / E2E). */
export async function cancelAllOpenOrders({
  cancelSource = 'e2e',
  ownerUserId = null,
} = {}) {
  return withIbGateway(
    async (ib) => {
      const found = [];
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);
        const onOpen = (orderId, contract, order) => {
          if (orderId != null) {
            found.push({
              order_id: orderId,
              symbol: contract?.symbol || '',
              exchange: contract?.primaryExch || contract?.exchange || '',
              action: order?.action || '',
            });
          }
        };
        const onEnd = () => {
          clearTimeout(t);
          ib.off(EventName.openOrder, onOpen);
          ib.off(EventName.openOrderEnd, onEnd);
          resolve();
        };
        ib.on(EventName.openOrder, onOpen);
        ib.on(EventName.openOrderEnd, onEnd);
        ib.reqAllOpenOrders();
      });
      const uniqueIds = [...new Set(found.map((f) => f.order_id))];
      for (const id of uniqueIds) {
        try {
          ib.cancelOrder(id);
        } catch {
          /* ignore */
        }
      }
      await new Promise((r) => setTimeout(r, 1000));

      if (ownerUserId) {
        try {
          const { recordOrderEvent, standardCancelReason } = await import('./ibkr-order-events.js');
          const std = standardCancelReason(cancelSource);
          for (const f of found) {
            const sym = String(f.symbol || '').toUpperCase();
            const ex = String(f.exchange || '').toUpperCase();
            recordOrderEvent({
              owner_user_id: ownerUserId,
              symbol_key: ex && sym ? `${ex}:${sym}` : sym || null,
              symbol: sym || null,
              side: f.action || null,
              ib_order_id: f.order_id,
              status: 'Cancelled',
              reason_code: std.reason_code,
              reason_text: std.reason_text,
              source: std.source,
            });
          }
        } catch {
          /* ignore logging failures */
        }
      }

      return { ok: true, cancelled: uniqueIds, orders: found, reason: cancelSource };
    },
    { requireTradingEnabled: true, timeoutMs: 45000 }
  );
}

/** Cancel open orders for a symbol (parents + children) before SELL_TO_CLOSE. */
export async function cancelOpenOrdersForSymbol(
  symbol,
  { cancelSource = 'before_sell', ownerUserId = null, symbolKey = null } = {}
) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return { ok: true, cancelled: [] };
  return withIbGateway(
    async (ib) => {
      const toCancel = [];
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 8000);
        const onOpen = (orderId, contract, order) => {
          if (String(contract?.symbol || '').toUpperCase() === sym) {
            toCancel.push({
              order_id: orderId,
              symbol: contract?.symbol || '',
              exchange: contract?.primaryExch || contract?.exchange || '',
              action: order?.action || '',
            });
          }
        };
        const onEnd = () => {
          clearTimeout(t);
          ib.off(EventName.openOrder, onOpen);
          ib.off(EventName.openOrderEnd, onEnd);
          resolve();
        };
        ib.on(EventName.openOrder, onOpen);
        ib.on(EventName.openOrderEnd, onEnd);
        ib.reqAllOpenOrders();
      });
      for (const row of toCancel) {
        try {
          ib.cancelOrder(row.order_id);
        } catch {
          /* ignore */
        }
      }
      await new Promise((r) => setTimeout(r, 500));

      if (ownerUserId && toCancel.length) {
        try {
          const { recordOrderEvent, standardCancelReason } = await import('./ibkr-order-events.js');
          const std = standardCancelReason(cancelSource);
          for (const f of toCancel) {
            recordOrderEvent({
              owner_user_id: ownerUserId,
              symbol_key: symbolKey || `${String(f.exchange || '').toUpperCase()}:${sym}`,
              symbol: sym,
              side: f.action || null,
              ib_order_id: f.order_id,
              status: 'Cancelled',
              reason_code: std.reason_code,
              reason_text: std.reason_text,
              source: std.source,
            });
          }
        } catch {
          /* ignore */
        }
      }

      return {
        ok: true,
        cancelled: toCancel.map((c) => c.order_id),
        orders: toCancel,
        symbol: sym,
        reason: cancelSource,
      };
    },
    { requireTradingEnabled: true, timeoutMs: 30000 }
  );
}
