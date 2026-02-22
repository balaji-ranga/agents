# Agent OS — OpenClaw Agent Space

Web platform for OpenClaw agents: org chart, human–agent chat (via OpenClaw gateway), and workspace MD file management (SOUL.md, AGENTS.md, MEMORY.md). Metadata is stored in a **lightweight SQLite** database.

## Interface: OpenClaw Gateway

The backend uses the [OpenClaw Gateway](https://docs.openclaw.ai/gateway) HTTP API:

- **Chat:** `POST /v1/chat/completions` (OpenAI-compatible)
  - Auth: `Authorization: Bearer <token>`
  - Agent: `x-openclaw-agent-id: main` (or agent id)
  - Session: `user` in body for stable session (per-agent, per-user)
- Enable in OpenClaw config: `gateway.http.endpoints.chatCompletions.enabled: true`
- Default gateway port: **18789**

## Prerequisites

- **Node.js 18+**
- **OpenClaw** installed and (for chat) **gateway** running with chat completions enabled
- **Workspace path** where SOUL.md, AGENTS.md, MEMORY.md live (for MD editor)
- **OPENAI_API_KEY** in backend `.env` for **Run COO** (standup + CEO summary via OpenAI). Optional: `OPENAI_COO_MODEL` (default `gpt-4o-mini`).
- Optional: **STANDUP_CRON_SCHEDULE** (cron expression, e.g. `0 9 * * *` for 9 AM daily) to run standup collection and COO automatically.
- Optional: **DELEGATION_CRON_SCHEDULE** (default `* * * * *` = every minute) — processes queued COO→agent messages and posts response callbacks to the standup so the COO never blocks on agent replies.

## Quick start

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env: set OPENCLAW_WORKSPACE_PATH and OPENCLAW_GATEWAY_TOKEN (if gateway uses auth)
npm install
# On Windows, if npm install fails on better-sqlite3 (EPERM), run in a normal terminal or with elevated permissions.
npm run dev
```

Backend runs at **http://127.0.0.1:3001**. Health: `GET /health`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at **http://127.0.0.1:3000** and proxies `/api` to the backend.

### 3. OpenClaw gateway (for chat)

**Requirement:** Node.js **22.12.0 or newer** (OpenClaw CLI checks this). Upgrade from [nodejs.org](https://nodejs.org) if needed.

OpenClaw is installed globally (`npm install -g openclaw@latest`). A config with **chat completions enabled** is at `~/.openclaw/openclaw.json` (created for you). To recreate or customize, copy from `agent-os/openclaw-config.example.json`.

Start the gateway:

```bash
openclaw setup          # first time only: bootstrap workspace
openclaw gateway --port 18789
```

Set in backend `.env`:

- `OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN=<your gateway token or password>` (if you set `gateway.auth` in OpenClaw config)

## What’s included

| Feature | Description |
|--------|-------------|
| **Dashboard** | List agents (org chart); add agent; open **Chat** per agent. |
| **Chat** | 1:1 chat with an OpenClaw agent via gateway; session affinity per agent; history stored in SQLite. |
| **Workspace** | View/edit SOUL.md, AGENTS.md, MEMORY.md (and optional daily `memory/*.md`). Backups on save. |
| **DB** | SQLite in `backend/data/agent-os.db`: agents, activities, chat_turns. |

## API (backend)

- `GET /health` — liveness
- `GET /workspace/files` — list MD files
- `GET /workspace/files/:name` — read file (e.g. `soul`, `agents`, `memory`)
- `PUT /workspace/files/:name` — write file (body: `{ "text": "..." }`)
- `GET /agents` — list agents
- `POST /agents` — create agent
- `GET /agents/:id` — get agent
- `PATCH /agents/:id` — update agent
- `DELETE /agents/:id` — delete agent
- `GET /agents/:id/chat` — chat history
- `POST /agents/:id/chat` — send message (body: `{ "message": "..." }`) → gateway → reply
- `GET /agents/:id/activities` — activity log
- `POST /agents/:id/activities` — append activity
- All API routes are under **`/api`** (e.g. `/api/standups`, `/api/cron`). The frontend uses `VITE_API_URL` or proxy to `/api`.
- `GET /api/standups` — list standups (query: `?limit=50`)
- `GET /api/standups/:id` — get standup with responses and messages
- `POST /api/standups` — create standup (body: `{ "scheduled_at": "...", "status": "scheduled" }`)
- `PATCH /api/standups/:id` — update standup (coo_summary, ceo_summary, status)
- `POST /api/standups/:id/responses` — add response (body: `{ "agent_id": "...", "content": "..." }`)
- `POST /api/standups/:id/run-coo` — generate COO + CEO summary via OpenAI (requires `OPENAI_API_KEY` in backend `.env`)
- `POST /api/cron/run-standup` — run standup flow now: create standup, collect status from agents (OpenClaw), run COO. Can be triggered manually from the Dashboard.
- `POST /api/cron/process-delegations` — aggregate completed delegation batches and post COO callback messages to standups (e.g. after OpenClaw cron webhooks have updated tasks).
- **Standup chat with COO:** `POST /api/standups/:id/messages` with `{ content }` — chat with the COO agent (OpenClaw). With `{ action: 'get_work_from_team' }` — **OpenClaw Gateway cron** is used: one one-shot job per agent is created via the Gateway's `/tools/invoke` (cron_add); each job runs the agent and POSTs the result to `POST /api/standups/cron-callback`. The backend then posts a COO message to the standup with the team's responses. **Check for updates** calls `POST /api/cron/process-delegations` to aggregate any completed batches. Set `AGENT_OS_BASE_URL` (or `PUBLIC_URL`) if the backend is not at `http://127.0.0.1:3001` so the webhook URL is reachable by the Gateway. Deep research: `{ action: 'request_research', content: '...' }` queues one task; same callback pattern.

## Restart and test

After code changes, restart backend (and frontend / gateway if needed). Then run:

```bash
cd backend && npm run test:smoke   # quick: health, agents, standups
cd backend && npm run test:full    # full: create agent, standups, workspace MD, chat (set SKIP_CHAT=1 if gateway not running)
```

See **TESTING.md** for full test cases (including frontend manual tests) and restart steps.

## Project layout

```
agent-os/
├── IMPLEMENTATION_PLAN.md
├── README.md
├── backend/
│   ├── .env.example
│   ├── package.json
│   ├── data/               # SQLite DB (created on first run)
│   └── src/
│       ├── index.js
│       ├── db/schema.js
│       ├── workspace/adapter.js
│       ├── gateway/openclaw.js
│       └── routes/workspace.js, agents.js
└── frontend/
    ├── package.json
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── api.js
        └── pages/Dashboard.jsx, Workspace.jsx, AgentChat.jsx
```

## License

Same as parent project.
