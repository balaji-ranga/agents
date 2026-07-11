# Agent OS — OpenClaw Agent Space

Web platform for OpenClaw agents: org chart, human–agent chat (via OpenClaw gateway), workspace MD management (SOUL.md, AGENTS.md, MEMORY.md, TOOLS.md), **custom visual workflows**, **Job Applicant pipeline**, **MCP integrations**, Kanban, standups, and content tools. Metadata is stored in a **lightweight SQLite** database.

## Interface: OpenClaw Gateway

The backend uses the [OpenClaw Gateway](https://docs.openclaw.ai/gateway) HTTP API:

- **Chat:** `POST /v1/chat/completions` (OpenAI-compatible)
  - Auth: `Authorization: Bearer <token>`
  - Agent: `x-openclaw-agent-id: main` (or agent id)
  - Session: `user` in body for stable session (per-agent, per-user)
- Enable in OpenClaw config: `gateway.http.endpoints.chatCompletions.enabled: true`
- Default gateway port: **18789**

## Prerequisites

- **Node.js 18+** (Node **22.12+** for OpenClaw CLI)
- **OpenClaw** installed and (for chat) **gateway** running with chat completions enabled
- **Workspace path** where SOUL.md, AGENTS.md, MEMORY.md live (for MD editor)
- **OPENAI_API_KEY** in backend `.env` for **Run COO** (standup + CEO summary via OpenAI). Optional: `OPENAI_COO_MODEL` (default `gpt-4o-mini`).
- Optional: **STANDUP_CRON_SCHEDULE** (cron expression, e.g. `0 9 * * *` for 9 AM daily) to run standup collection and COO automatically.
- Optional: **DELEGATION_CRON_SCHEDULE** (default `* * * * *` = every minute) — processes queued COO→agent messages and posts response callbacks to the standup so the COO never blocks on agent replies.
- Optional: **AGENT_OS_BASE_URL**, **AGENT_OS_PUBLIC_URL**, or **PUBLIC_URL** — public DNS/HTTPS base URL for workflow event hooks, cron webhooks, and artifact links. Defaults to `http://127.0.0.1:3001` for local dev.
- Optional: **AGENT_OS_DATA_DIR** — directory for SQLite DB (default: `backend/data`).
- Optional: **AGENT_OS_ADMIN_EMAIL** / **AGENT_OS_ADMIN_PASSWORD** — platform admin seeded on first startup.
- Optional: **AGENT_OS_BALA_CEO_*** — default CEO user for job profiles and workflows.

## Quick start

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env: set OPENCLAW_WORKSPACE_PATH, OPENCLAW_GATEWAY_TOKEN, OPENAI_API_KEY
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

Frontend runs at **http://127.0.0.1:3000** and proxies `/api` to the backend (override with `VITE_API_PROXY_TARGET` in dev; set `VITE_API_URL` for production builds).

### 3. Log in

Open **http://127.0.0.1:3000/login**. Default admin is seeded from `.env` (`AGENT_OS_ADMIN_*`). CEO users see Dashboard, Workflows, Kanban, Job profiles, etc. Admin users manage platform accounts and MCP registry.

### 4. OpenClaw gateway (for chat)

OpenClaw is installed globally (`npm install -g openclaw@latest`). A config with **chat completions enabled** is at `~/.openclaw/openclaw.json` (copy from `agent-os/openclaw-config.example.json`).

Start the gateway:

```bash
openclaw setup          # first time only: bootstrap workspace
openclaw gateway --port 18789
```

Set in backend `.env`:

- `OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN=<your gateway token or password>` (if you set `gateway.auth` in OpenClaw config). **If you see "gateway closed (1008): pairing required"**, see **knowledgebase/GATEWAY-PAIRING-1008.md**.

**Setting up OpenClaw from scratch:** Run `.\scripts\setup-openclaw-from-scratch.ps1` from the `agent-os` folder. It bootstraps OpenClaw, seeds the DB (all agents + ExpenseManager), installs agent-send and content-tools skills and extension, applies `openclaw.json` (agents, plugins, Ollama), ensures workspace templates (SOUL/MEMORY/TOOLS) and COO AGENTS.md, and ensures agent dirs. Then run `openclaw gateway --port 18789` and start backend + frontend.

## What’s included

| Feature | Description |
|--------|-------------|
| **Auth & roles** | Login/register; **admin** (user management, MCP registry) and **ceo** (agents, workflows, kanban, job pipeline). JWT sessions. |
| **Dashboard** | List agents (org chart); add agent; open **Chat** per agent; standups with COO chat; **delete all standups**; sync from OpenClaw. |
| **Chat** | 1:1 chat with an OpenClaw agent via gateway; session affinity per agent; history stored in SQLite. |
| **Agent workspace** | Per-agent **SOUL.md, AGENTS.md, MEMORY.md, TOOLS.md** editor; **Tools access** panel (grant/revoke content tools per agent, hot-sync to OpenClaw without gateway restart). |
| **Notifications** | **Bell icon** in nav: recent agent delegation responses; link to agent Chat; clear/dismiss. |
| **Kanban** | Board view (tasks by agent and status); task detail with **task chat**, artifacts, workflow run links. Reopen task; create task (COO or direct to agent). |
| **Custom workflows** | Visual **Workflows** editor (separate from Job workflows): trigger (manual / schedule / chat / event webhook), agent, API, MCP tool, **SSE listen**, **sub-workflow**, Brain (LLM + optional MCP tool calling), email, IF/While, parallel/merge, CEO approval, **external agent (A2A)**. Publish, run instances, paginated run history, search, **stop SSE listen** on active runs. |
| **Workflow Builder chat** | LLM assistant in the workflow editor to create/edit graphs via natural language. |
| **Job profiles** | CEO job search profiles (intake, resume, preferences); gate for Job Applicant pipeline. |
| **Job workflows** | Multi-agent **Job Applicant** pipeline (Discovery → Fit Scoring → Resume Tailoring → Application); Kanban-tracked stages; browser/Playwright apply path. See **knowledgebase/JOB-APPLICANT-WORKFLOW.md**. |
| **MCP integrations** | Register MCP servers (admin/CEO); connect, test tools, playground; use in workflow **MCP Tool** and **SSE Listen** nodes. Local test server: `tools/local-mcp-random-sse/`. |
| **External agents (A2A)** | Register external agent endpoints; invoke from workflow **External Agent** node. |
| **Content tools** | Agent-callable tools (summarize URL, image/video gen, Kanban, workflow trigger/enquire, job applicant tools, etc.); logs UI; onboard new APIs via script. |
| **Broadcast** | Send messages to multiple agents. |
| **Tools onboarding** | Script `scripts/onboard-api-tool.js` onboards a new API as a tool from JSON (updates DB, OpenClaw tool list). See `scripts/tool-definitions/README.md`. |
| **Workspace (legacy MD)** | Global workspace MD editor (older path); prefer **Agent workspace** per agent. |
| **DB** | SQLite: agents, users, chat, standups, delegations, kanban, content tools, job profiles/applications, MCP servers, agent workflow definitions/runs, external agents, audit. |
| **Agent memory** | Backend injects each agent’s MEMORY.md into delegation prompts and appends summaries on task completion. |

### Custom Agent Workflows (high level)

- **Editor:** `/workflows` → create from template or blank → `/workflows/:id/edit`
- **Triggers:** manual, cron schedule, chat phrase, **event webhook** (hook URL on Start node when event mode enabled; uses `AGENT_OS_BASE_URL`)
- **Node types:** Trigger, Agent, Content Tool, MCP Tool, **SSE Listen** (long-running stream; dispatches downstream on each event), **Sub-workflow**, Call API (Basic/Bearer/API-key auth + custom headers), Brain, Email, IF, While, Parallel, Merge, CEO Approval, External Agent
- **Data binding:** `{{nodeId.outputKey}}` templates; nested JSON paths (e.g. `{{api-1.body.users.0.name}}`)
- **Runs:** Kanban tasks per step; fail run on API/MCP errors (non-2xx HTTP, SSL errors, MCP `is_error`)
- **Tests:** `node backend/scripts/test-sse-workflow.js`, `node backend/scripts/demo-sse-hook-and-listen.js`

### Job Applicant vs Custom Workflows

| | **Job workflows** (`/job-workflows`) | **Workflows** (`/workflows`) |
|--|--------------------------------------|------------------------------|
| Purpose | Fixed multi-agent job search/apply pipeline | User-defined graphs |
| Orchestration | COO + specialist agents + pipeline cron | Backend workflow runner |
| Setup | `node scripts/setup-job-applicant-agents.js` | UI or Workflow Builder chat |

### Tools access vs TOOLS.md

- **Tools access** (Workspace UI): enforcement — which Agent OS tools OpenClaw exposes to the agent (`agent_tool_grants`, `~/.openclaw/agent-tool-allowlists.json`).
- **TOOLS.md**: instructions for the LLM — when and how to use granted tools. Sync from template via Workspace UI.

### Hosting / DNS

For production, set in backend `.env`:

```env
AGENT_OS_BASE_URL=https://your-domain.example
```

For frontend production build:

```env
VITE_API_URL=https://your-domain.example/api
```

Workflow hook URLs, cron webhooks, and MCP/API endpoints in graphs should use your public DNS — not `127.0.0.1`. See `backend/.env.example`.

## Production deploy (Docker / Podman)

Container stack: **nginx** + **frontend** + **backend** + **OpenClaw gateway**, with optional **init**, **Ollama**, **MCP test server**, and **browser-login** profiles.

```bash
cd deploy
cp .env.example .env   # set AGENT_OS_PUBLIC_URL, OPENCLAW_GATEWAY_TOKEN, OPENAI_API_KEY
./scripts/up.sh        # USE_PODMAN=1 on CentOS
```

- **deploy/README.md** — Compose services, volumes, profiles
- **knowledgebase/DEPLOY-CENTOS-PODMAN.md** — CentOS, Podman, SELinux, Chromium/browser login
- **scripts/setup-openclaw-from-scratch.sh** — Linux bootstrap (also runs in the `init` container)

## Tools onboarding (script)

Create a JSON file in `scripts/tool-definitions/` with `name`, `description`, `endpoint`, `method`, optional `api_key_bearer`, and `applicable_agents`. Run from the `agent-os` folder:

```bash
node scripts/onboard-api-tool.js scripts/tool-definitions/your-tool.json
```

Restart the OpenClaw gateway. See `scripts/tool-definitions/README.md`.

## API (backend)

All routes below are also available under **`/api/...`** (frontend uses `/api` proxy or `VITE_API_URL`).

### Core

- `GET /health` — liveness
- **Auth:** `POST /auth/login`, `POST /auth/register`, `GET /auth/me`, profile update
- **Admin:** `GET/POST /admin/users`, enable/disable users, grant agents

### Agents & workspace

- `GET/POST/PATCH/DELETE /agents` — agent CRUD
- `GET/POST /agents/:id/chat` — chat history and send message (→ gateway)
- `GET/PUT /agents/:id/workspace/:file` — SOUL, agents, memory, tools MD
- `GET/PUT /agents/:id/tools` — per-agent content tool grants

### Standups, Kanban, cron

- `GET/POST/PATCH/DELETE /standups`, `/standups/:id/messages`, `/standups/:id/run-coo`
- `GET /standups/notifications` — bell feed
- `GET/PATCH /kanban/tasks`, task messages, reopen, artifacts
- `POST /cron/run-standup`, `POST /cron/process-delegations`

### Content tools

- `GET /tools/meta`, `POST /tools/invoke`, workflow chat tools (`agent_workflow_*`), job applicant tools

### Job applicant

- `/job-applicant/*` — profiles, applications, pipeline runs, browser auth, CEO review. See **knowledgebase/JOB-APPLICANT-WORKFLOW.md**.

### Custom agent workflows

- `GET/POST/PATCH/DELETE /agent-workflows` — definitions, publish, audit
- `POST /agent-workflows/:id/run` — start run
- `GET /agent-workflows/runs` — paginated runs (`?page=&limit=&q=`)
- `POST /agent-workflows/runs/:runId/listen/:nodeId/stop` — stop SSE listen
- `POST /agent-workflows/hooks/:definitionId` — event trigger (webhook secret header)
- `POST /agent-workflows/agent-chat` — Workflow Builder LLM
- `POST /agent-workflows/approval/respond` — CEO approval from Kanban

### MCP & external agents

- `/integrations/mcp/*` — MCP server registry, connect, test, call tool
- `/external-agents/*` — A2A agent registry and task invoke

### Media

- `GET /media/openclaw/*` — proxied OpenClaw media for chat/kanban display

## Restart and test

```bash
cd backend && npm run test:smoke   # quick: health, agents, standups
cd backend && npm run test:full    # full suite (set SKIP_CHAT=1 if gateway not running)
node backend/scripts/test-sse-workflow.js   # SSE + workflow E2E (local MCP on 3099)
```

PowerShell helpers: `scripts/stop-and-restart-backend-frontend.ps1`, `scripts/stop-and-restart-gateway.ps1`, `scripts/stop-and-restart-all.ps1`.

See **knowledgebase/TESTING.md** for full test cases and restart steps.

## Database and scripts

- **Schema:** `backend/src/db/schema.js` — `initDb()`, `getDb()`. DB: `backend/data/agent-os.db` (or `AGENT_OS_DATA_DIR`).
- **Seeds:** `seed-default-agents.js`, `seed-content-tools-meta.js`, `seed-job-applicant-tools.js`, `seed-workflow-builder-agent.js`
- **Backend scripts:** `backend/scripts/` — seeds, E2E tests, MCP seed, workflow tests, `cleanup-workflow-runs.js`
- **OpenClaw scripts:** `scripts/` — `setup-openclaw-from-scratch.ps1`, `onboard-api-tool.js`, `apply-openclaw-agents-config.js`, `setup-job-applicant-agents.js`, `sync-browser-tools-md.js`, `install-agent-os-content-tools-extension.js`, kill/restart helpers

No separate migration folder; schema changes use `ALTER TABLE` blocks in `schema.js`.

## Project layout

```
agent-os/
├── README.md
├── knowledgebase/              # Extended docs (see index below)
├── scripts/                    # OpenClaw/workspace; onboard-api-tool.js; tool-definitions/
├── tools/local-mcp-random-sse/ # Dev MCP + SSE test server (port 3099)
├── openclaw-workspace-templates/  # SOUL, AGENTS, MEMORY, TOOLS per agent type
├── openclaw-skills/            # agent-send, agent-os-content-tools, etc.
├── openclaw-extensions/        # agent-os-content-tools plugin, bootstrap watcher
├── backend/
│   ├── .env.example
│   ├── data/                   # SQLite
│   ├── scripts/                # seeds, E2E, workflow tests
│   └── src/
│       ├── index.js
│       ├── config/             # llm, public-url, tools
│       ├── db/
│       ├── routes/             # auth, admin, agents, kanban, job-applicant,
│       │                         # agent-workflows, mcp-integrations, external-agents, …
│       ├── services/             # workflow runner, MCP, job pipeline, delegation, …
│       └── gateway/openclaw.js
└── frontend/
    └── src/
        ├── pages/              # Dashboard, AgentChat, AgentWorkspace, Kanban,
        │                         # AgentWorkflows, AgentWorkflowEditor, JobProfiles,
        │                         # JobWorkflows, McpIntegrations, ExternalAgents, …
        └── components/           # NotificationBell, workflow editor nodes, Kanban artifacts
```

## Documentation (knowledge base)

All project docs except this README live in **`knowledgebase/`**:

| File | Purpose |
|------|---------|
| **TESTING.md** | Restart, API tests, frontend manual tests, smoke test |
| **JOB-APPLICANT-WORKFLOW.md** | Job pipeline agents, tools, profile intake, setup |
| **GATEWAY-PAIRING-1008.md** | Fix gateway pairing / token |
| **SESSION-HISTORY-VISIBILITY-TREE.md** | OpenClaw session visibility |
| **AGENT_REVIEW_AND_SKILLS.md** | Agent roles and skills |
| **CONFIGURE-CLAUDE-OPUS.md** | Anthropic model in openclaw.json |
| **IMPLEMENTATION_PLAN.md** | Roadmap and phases |
| **GITHUB-SETUP.md** | Push to GitHub |
| **SOCIAL_POSTING_OPTIONS.md** | SocialAssistant posting options |
| **ADD-AGENT-VS-RECENT-FIXES-VALIDATION.md** | Agent creation vs config scripts |

See **knowledgebase/README.md** for the full index.

## License

Same as parent project.
