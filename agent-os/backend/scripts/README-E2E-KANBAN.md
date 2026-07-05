# E2E Kanban test with OpenClaw gateway

## Full flow (only agents move status via tools)

1. **Start backend** (terminal 1). Restart after code changes so the running process uses the latest code.
   ```bash
   cd agent-os/backend && node src/index.js
   ```
   Ensure the gateway can reach it (e.g. `AGENT_OS_BASE_URL=http://127.0.0.1:3001` or same host).

2. **Start OpenClaw gateway** (terminal 2):
   ```bash
   cd agent-os
   npx openclaw gateway --port 18789
   ```
   Or from your OpenClaw install: `openclaw gateway --port 18789`.

3. **Run the e2e script** (terminal 3):
   ```bash
   cd agent-os
   node backend/scripts/e2e-kanban-with-gateway.js
   ```

4. **What should happen**
   - Backend creates standup and sends message; intent classification creates 2 Kanban tasks (TechResearcher + SocialAssistant).
   - Backend calls gateway `cron.add` for each agent; gateway runs each agent with the prompt (including Kanban task ID and instruction to call **kanban_move_status**).
   - **Only agents** move Kanban status: each agent must call **kanban_move_status** (in_progress, then completed/failed). Backend does not update Kanban from delegation completion.
   - When an agent finishes, the gateway POSTs to cron-callback; backend only updates the delegation task and chat, not the Kanban task.
   - The test **PASS** requires both tasks completed/failed **and** at least one successful **kanban_move_status** call in Content tools logs.

5. **If gateway is not running**
   - The script will warn and wait; after ~30 s it triggers `POST /api/cron/process-delegations` (fallback: run agents via backend→gateway chat). If the gateway is still down, those runs fail and tasks go to **failed** but the test still “passes” (both tasks left pending/failed and we marked them via fallback).

## Environment

- `API_BASE` or `AGENT_OS_BASE_URL`: backend URL (default `http://127.0.0.1:3001`).
- `OPENCLAW_GATEWAY_URL`: gateway URL (default `http://127.0.0.1:18789`).
- Backend must be reachable from the machine where the gateway runs (for cron-callback webhook).
