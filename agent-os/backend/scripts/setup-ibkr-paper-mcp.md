# IBKR paper MCP setup (Agent OS)

Prerequisites: IB Gateway or TWS logged into a **paper** account, API enabled on port **7497**, Trusted IP `127.0.0.1`.

## 0. Quick Agent OS paper test (no Gateway)

```bash
cd backend
node scripts/test-ibkr-paper-pipeline.js
```

Exercises preflight → validate → dry-run place → day-status (`IBKR_TRADING_ENABLED=0`).

HTTP (backend must be restarted after pulling IBKR routes):

```bash
curl -X POST http://127.0.0.1:3001/api/ibkr-trading/preflight -H "Content-Type: application/json" -H "x-internal-test: 1" -d "{\"cash_usd\":1000}"
```

## 1. Start IB Gateway / TWS (paper)

```bash
cd backend
node scripts/check-ibkr-gateway.js
```

If all ports are DOWN:

1. Install IB Gateway or TWS: https://www.interactivebrokers.com/en/trading/ibgateway-stable.php
2. Log in with **Paper** account (not live).
3. Configure → Settings → API:
   - Enable ActiveX and Socket Clients
   - Socket port **7497** (TWS paper) or **4002** (Gateway paper)
   - Trusted IPs: `127.0.0.1`
4. Re-run `check-ibkr-gateway.js` until one port shows **UP**, then set `IBKR_PORT` in `.env` to that port.

## 2. Start community MCP (code-rabi)

```bash
npx -y interactive-brokers-mcp
```

Optional headless (needs your IB paper credentials — do not commit):

```env
IB_HEADLESS_MODE=true
IB_USERNAME=...
IB_PASSWORD_AUTH=...
IB_PAPER_TRADING=true
```

Prefer **read-only** until maker/checker + CEO day plan is proven.

## 3. Register in Agent OS

Integrations → MCP → Add server (URL/stdio from the MCP process), probe until **healthy**.

## 4. Agent OS env

`IBKR_HOST=127.0.0.1`, `IBKR_PORT=4002` (Gateway paper), `IBKR_IS_PAPER=true`, `IBKR_TRADING_ENABLED=1` for live paper place via Gateway (`@stoqey/ib`). Use `0` for ledger-only dry-run.

## 5. Seed workflow

```bash
cd backend
node scripts/seed-ibkr-maker-checker-workflow.js
```

Set OpenAI **API key on the Maker Brain node**. Checker uses **Ollama** locally (no Anthropic key). Publish when ready.

Chat phrase: `run ibkr day plan`
