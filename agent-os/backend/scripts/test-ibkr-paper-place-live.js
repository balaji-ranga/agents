/**
 * Direct paper place smoke test (1 share NVDA bracket via Gateway).
 * Usage: node scripts/test-ibkr-paper-place-live.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { pingIbGateway, placeBracketTrade } from '../src/services/ibkr-gateway-client.js';

async function main() {
  console.log('TRADING_ENABLED', process.env.IBKR_TRADING_ENABLED);
  console.log('IS_PAPER', process.env.IBKR_IS_PAPER);
  console.log('PORT', process.env.IBKR_PORT);

  const ping = await pingIbGateway();
  console.log('ping', ping);

  // Slightly above a plausible ref so limit may rest overnight if market closed
  const trade = {
    key: 'NASDAQ:NVDA',
    symbol: 'NVDA',
    exchange: 'NASDAQ',
    currency: 'USD',
    side: 'BUY',
    qty: 1,
    entry_price: 1.0, // intentionally low — will sit as working limit on paper; change if you want fill
    tp_price: 1.02,
    stop_price: 0.98,
  };

  // Use realistic prices if IBKR_SMOKE_FILL=1
  if (process.env.IBKR_SMOKE_FILL === '1') {
    trade.entry_price = Number(process.env.IBKR_SMOKE_ENTRY || 180);
    trade.tp_price = round(trade.entry_price * 1.01);
    trade.stop_price = round(trade.entry_price * 0.985);
  }

  console.log('placing', trade);
  const result = await placeBracketTrade(trade);
  console.log('RESULT', JSON.stringify(result, null, 2));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
