/**
 * Probe IBKR API socket ports and print fix steps.
 * Usage: node scripts/check-ibkr-gateway.js
 *
 * Paper ports: TWS 7497 · IB Gateway 4002
 * Live ports:  TWS 7496 · IB Gateway 4001
 */
import { config } from 'dotenv';
import { createConnection } from 'net';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const CANDIDATES = [
  { port: 4000, label: 'IB Gateway LocalServerPort (jts.ini)' },
  { port: 4002, label: 'IB Gateway paper (classic)' },
  { port: 7497, label: 'TWS paper' },
  { port: 7496, label: 'TWS live' },
  { port: 4001, label: 'IB Gateway live' },
  { port: Number(process.env.IBKR_PORT || 0) || null, label: 'IBKR_PORT from .env' },
].filter((c, i, arr) => c.port && arr.findIndex((x) => x.port === c.port) === i);

function probe(port, host = '127.0.0.1', ms = 1500) {
  return new Promise((resolve) => {
    const s = createConnection({ host, port }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    setTimeout(() => {
      try {
        s.destroy();
      } catch (_) {}
      resolve(false);
    }, ms);
  });
}

function findInstallHints() {
  const hints = [];
  const home = homedir();
  for (const p of [
    join(home, 'Jts'),
    join(home, 'IBC'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'ibgateway'),
    'C:\\Jts',
    'C:\\IBC',
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Interactive Brokers'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Interactive Brokers'),
  ]) {
    if (existsSync(p)) {
      hints.push(p);
      try {
        const kids = readdirSync(p).slice(0, 8);
        if (kids.length) hints.push(`  contents: ${kids.join(', ')}`);
      } catch (_) {}
    }
  }
  return hints;
}

async function main() {
  const host = process.env.IBKR_HOST || '127.0.0.1';
  console.log('=== IBKR Gateway / TWS port check ===');
  console.log('host', host);
  console.log('env IBKR_PORT', process.env.IBKR_PORT || '(unset)');
  console.log('env IBKR_IS_PAPER', process.env.IBKR_IS_PAPER ?? '(unset)');

  let openPort = null;
  for (const c of CANDIDATES) {
    const up = await probe(c.port, host);
    console.log(`${up ? 'UP  ' : 'DOWN'} ${c.port}  (${c.label})`);
    if (up && !openPort) openPort = c;
  }

  const installs = findInstallHints();
  if (installs.length) {
    console.log('\nInstall / data dirs found:');
    installs.forEach((l) => console.log(' ', l));
  } else {
    console.log('\nNo local Jts/IB Gateway install dir found under common paths.');
  }

  if (openPort) {
    console.log(`\nOK — API socket listening on ${openPort.port} (${openPort.label})`);
    if (String(process.env.IBKR_PORT || '') !== String(openPort.port)) {
      console.log(`Set in backend/.env: IBKR_PORT=${openPort.port}`);
    }
    process.exit(0);
  }

  console.log(`
FAIL — no IB API port is open.

Fix (paper):
1. Install IB Gateway or TWS: https://www.interactivebrokers.com/en/trading/ibgateway-stable.php
2. Log in with PAPER account (not live).
3. Configure → Settings → API:
   - Enable ActiveX and Socket Clients
   - Socket port: 7497 (TWS paper) or 4002 (Gateway paper)
   - Add Trusted IP: 127.0.0.1
   - Uncheck Read-Only API if you need order placement later
4. Leave Gateway/TWS running, then re-run:
   node scripts/check-ibkr-gateway.js
5. Align backend/.env:
   IBKR_HOST=127.0.0.1
   IBKR_PORT=<open port>
   IBKR_IS_PAPER=true
   IBKR_CLIENT_ID=1
`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
