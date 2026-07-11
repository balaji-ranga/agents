# Local MCP Random SSE Test Server

Minimal MCP server for testing **SSE events** and **workflow event hooks**.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` | MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`) |
| `GET` | `/events/stream` | SSE stream of `random_number` events |
| `GET` | `/health` | Health + subscriber count |

## Tools

- **`get_random_number`** — returns `{ value, parity }` (no SSE)
- **`emit_random_event`** — broadcasts one SSE event to all subscribers (+ optional workflow hook POST)

## Run

```powershell
cd agent-os
node tools/local-mcp-random-sse/server.js
```

Default: `http://127.0.0.1:3099`

## Env

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_RANDOM_PORT` | `3099` | Listen port |
| `MCP_AUTO_EMIT_MS` | `5000` | Auto-emit while subscribers connected (`0` = off) |
| `WORKFLOW_HOOK_URL` | — | POST event JSON to Agent OS hook when emitting |
| `WORKFLOW_HOOK_SECRET` | — | `X-Workflow-Hook-Secret` header value |

## Register in Agent OS

```powershell
node backend/scripts/seed-local-mcp-random-sse.js
```

Then **Integrations → MCP → Connect** and test `emit_random_event` in the MCP playground.

## Workflow testing

```powershell
# Terminal 1 — MCP server
node tools/local-mcp-random-sse/server.js

# Terminal 2 — E2E (seeds workflows + runs tests)
node backend/scripts/test-sse-workflow.js
```
