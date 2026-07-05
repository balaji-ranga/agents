# Agent Operating System (Agent OS) — Implementation Plan

**Goal:** Build a web platform (“Agent OS Space”) for OpenClaw agents that provides org chart, COO agent, activities, standups, CEO summarization, MD file management (soul.md, agents.md, memory.md), and reports/monitoring. Use Anthropic skills from GitHub where applicable; deploy your own frontend, backend, and testing.

---

## Prerequisites (Before You Start)

Ensure the following are in place before beginning implementation.

### OpenClaw environment

| Prerequisite | Details |
|--------------|---------|
| **OpenClaw installed and runnable** | OpenClaw CLI/runtime installed (see [OpenClaw docs](https://docs.openclaw.ai)); you can start a session and the agent responds. |
| **At least one workspace** | A configured agent workspace (default `~/.openclaw/workspace` or a path you control). The Agent OS backend will read/write this path. |
| **Workspace path known** | You know the workspace root path so it can be set in Agent OS config (e.g. `OPENCLAW_WORKSPACE_PATH` or `agents.defaults.workspace`). |
| **Memory files present (or creatable)** | For MD file management (Phase 1): at least one of **SOUL.md**, **AGENTS.md**, **MEMORY.md** exists in the workspace, or you are okay creating them via `openclaw setup` / templates. Optional: IDENTITY.md, USER.md, TOOLS.md, and `memory/` for daily logs. |

### Agents (for org chart, standups, COO)

| Prerequisite | Details |
|--------------|---------|
| **At least one agent identity** | One OpenClaw agent/workspace is enough to start Phase 1 (MD editing) and Phase 2 (org chart with one node). For standups and COO, you need a clear notion of "agents" (e.g. one workspace per agent, or multiple agent configs in one setup). |
| **COO designation** | Decide which agent (or synthetic role) will act as COO; the plan uses a single COO that aggregates standups and produces CEO summaries. You can start with a single agent and add a "COO" agent later. |
| **Optional: multiple agents** | For standups and org chart to be meaningful, plan for at least 2–3 agents (separate workspaces or configs). Not required for Phase 1–2. |

### Development and APIs

| Prerequisite | Details |
|--------------|---------|
| **Runtime** | Node.js 18+ and/or Python 3.10+ (depending on chosen backend). |
| **Anthropic API key** | Claude API key for COO summarization and any Claude-backed features. |
| **Azure Speech key (optional for Phase 1)** | For voice summarization (Phase 4): Azure subscription and Speech resource, or use of free tier; key in env (e.g. `AZURE_SPEECH_KEY`). Can be added later. |
| **Git and repo** | Git available; a repo for Agent OS (e.g. `agent-os/` or separate repo) to hold frontend, backend, skills, tests. |

### OpenClaw state (for token monitoring)

| Prerequisite | Details |
|--------------|---------|
| **OpenClaw state path** | For token usage monitoring (Phase 5): know where OpenClaw stores session/usage data (e.g. `~/.openclaw` or `OPENCLAW_STATE_DIR`). Token ingestion will depend on what OpenClaw exposes (session logs, gateway metadata, or provider usage); you may need to inspect the state dir or OpenClaw docs once you reach Phase 5. |

### Minimal start (Phase 1 only)

To start **Phase 1 only** (MD file management in the web UI), you need:

- OpenClaw installed and at least one workspace path.
- At least one of SOUL.md, AGENTS.md, or MEMORY.md in that workspace (or create empty ones).
- Backend and frontend runtimes (Node or Python); Claude API key for future phases (optional for Phase 1 if you are not calling Claude yet).

You do **not** need multiple agents, a COO, or Azure Speech to begin Phase 1.

---

## 1. Vision & Scope

### 1.1 Product Summary

| Area | Description |
|------|-------------|
| **Org chart** | Visual hierarchy of agents (roles, reporting lines, COO as central node). |
| **COO agent** | Main orchestrator: coordinates standups, aggregates summaries, escalates to human (CEO). |
| **Agent activities** | Timeline/feed of what each agent did (tasks, decisions, file edits). |
| **Standups** | Structured async standups between agents; optional schedule (e.g. daily). |
| **CEO summarization** | Human gets concise daily/weekly digests (progress, blockers, decisions). |
| **Voice summarization** | CEO summaries (and optional standup summaries) delivered as spoken audio using **Microsoft free TTS** voice models (e.g. Azure Speech free tier / free voices) for listen-in-the-car or hands-free consumption. |
| **MD file management** | Web UI to view/edit **SOUL.md**, **AGENTS.md**, **MEMORY.md** (and optionally IDENTITY.md, USER.md, TOOLS.md, daily `memory/YYYY-MM-DD.md`) for OpenClaw workspaces. |
| **Human–agent interaction** | **Ability for the human (CEO/user) to interact with each OpenClaw agent separately in the web platform**: 1:1 chat per agent; select an agent from the org chart or list, open a conversation, send messages and receive replies in the same session context as that agent’s workspace (SOUL/AGENTS/MEMORY). |
| **Reports & monitoring** | Performance (task completion, latency), coordination (handoffs, dependencies), activity history (audit log, search). **Token usage monitoring** for all models powering OpenClaw (input/output tokens per model, per session/request, trends and cost visibility). |

### 1.2 OpenClaw Context (Reference)

- **AGENTS.md** — Operating contract: priorities, boundaries, workflow.
- **SOUL.md** — Behavioral core: voice, temperament, values.
- **MEMORY.md** — Long-lived facts; daily logs in `memory/YYYY-MM-DD.md`.
- Workspace path: typically `~/.openclaw/workspace` (configurable).
- No standard REST API for file access; integration is via **filesystem** or **OpenClaw gateway** if/when available.

### 1.3 Anthropic Skills to Leverage

From [anthropics/skills](https://github.com/anthropics/skills):

| Skill | Use in Agent OS |
|-------|-----------------|
| **internal-comms** | Templates for standup format, status updates, internal summaries. |
| **doc-coauthoring** | Assisting structured edits to AGENTS.md / SOUL.md / MEMORY.md (diffs, versioning). |
| **docx / pdf** | Optional: export CEO reports as DOCX/PDF. |
| **webapp-testing** | E2E and UI testing of the web platform. |
| **frontend-design** | UI/UX consistency and component patterns. |
| **skill-creator** | Add custom “Agent OS” skills (e.g. “standup summarizer”, “org-chart updater”). |
| **mcp-builder** | Optional: MCP server that exposes org chart, activities, standups to other tools. |

Custom skills to add (in Agent OS repo):

- **agent-os-coo**: COO behavior — run standups, aggregate agent outputs, produce CEO summary.
- **agent-os-memory-editor**: Safe read/write patterns for SOUL.md, AGENTS.md, MEMORY.md (with validation and backup).

---

## 2. Architecture

### 2.1 High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Agent OS Web Platform                            │
├─────────────────────────────────────────────────────────────────────────┤
│  Frontend (React/Next.js or Vue)                                        │
│  • Org chart  • COO dashboard  • Activities  • Standups  • CEO summary  │
│  • Direct chat with each agent (human–agent 1:1)  • Voice summary (TTS)  │
│  • MD editor  • Reports & monitoring  • Token usage dashboard          │
├─────────────────────────────────────────────────────────────────────────┤
│  Backend API (Node.js / Python FastAPI)                                  │
│  • REST/GraphQL  • Auth  • Workspace file proxy  • Event store          │
│  • Agent chat proxy (route messages to OpenClaw per agent)              │
│  • Standup scheduler  • Summary generation (Claude API + skills)         │
│  • TTS service (Microsoft Azure Speech / free TTS)  • Token usage ingest │
├─────────────────────────────────────────────────────────────────────────┤
│  Integration Layer                                                      │
│  • OpenClaw workspace adapter (read/write MD files)                      │
│  • OpenClaw chat adapter (send/receive turns per agent workspace)        │
│  • Claude API + Agent Skills (COO, summarization, internal-comms)        │
│  • Optional: OpenClaw gateway / MCP for chat if available               │
├─────────────────────────────────────────────────────────────────────────┤
│  Data & Storage                                                          │
│  • SQLite/Postgres: org chart, standups, activities, reports, token_usage  │
│  • File system: OpenClaw workspace (SOUL.md, AGENTS.md, MEMORY.md, etc.) │
│  • Optional: vector store for activity search                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **Frontend** | SPA for org chart, COO view, activity feed, standup list/detail, CEO summary, **per-agent chat UI** (human interacts with each OpenClaw agent separately), voice summary player, MD editor, token usage dashboard, reports. |
| **Backend** | API for CRUD on org, activities, standups; file read/write to workspace; **agent chat proxy** (route user messages to the correct OpenClaw agent and return replies); job queue for standups and summaries; TTS generation; ingest and store OpenClaw model token usage. |
| **OpenClaw adapter** | Resolve workspace path(s), read/write SOUL.md, AGENTS.md, MEMORY.md, daily memory; optional multi-workspace. **Optionally read session/usage data for token metrics** (if OpenClaw exposes it). |
| **OpenClaw chat adapter** | **Human–agent interaction**: send user message to the chosen agent’s session (or create/resume session for that workspace); receive agent reply. Implementation depends on OpenClaw: gateway API, MCP, or subprocess/CLI wrapper; session affinity per agent. |
| **COO service** | Invoke Claude with COO skill; input = agent activities + last standups; output = standup agenda, summary, CEO digest. |
| **Testing** | Unit (API, adapters), integration (API + file system), E2E (Playwright/Cypress); use **webapp-testing** skill patterns. |

---

## 3. Tech Stack Recommendation

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Frontend** | Next.js 14+ (App Router) or React + Vite | SSR/API routes, good DX; fits frontend-design skill. |
| **UI** | Tailwind + shadcn/ui or similar | Fast, consistent; easy to align with Anthropic frontend-design. |
| **Backend** | Node.js (Express/Fastify) or Python (FastAPI) | Either works; Node if you want one language with frontend. |
| **DB** | SQLite (dev) / Postgres (prod) | Org, standups, activities, audit. |
| **Claude** | Anthropic API + Skills (container parameter) | COO, summarization, internal-comms; custom Agent OS skills. |
| **Files** | Direct FS access to OpenClaw workspace | Primary integration until OpenClaw exposes an API. |
| **Testing** | Vitest/Jest (unit), Playwright (E2E) | Use webapp-testing skill for E2E patterns. |
| **TTS (voice)** | Microsoft Azure Speech (TTS) or free-tier / free neural voices | **Voice summarization**: CEO (and optional standup) summaries as audio; use free tier or free voices where available. |
| **Token monitoring** | Store usage in DB; ingest from OpenClaw session/API response metadata or gateway logs | Visibility into input/output tokens per model used by OpenClaw; cost and trend reporting. |
| **Deploy** | Docker Compose (frontend + backend + DB); optional Vercel (frontend) + Railway/Render (backend) | Simple to run “your own” stack. |

---

## 4. Implementation Phases

### Phase 1: Foundation (Weeks 1–2)

- **1.1** Repo layout: `frontend/`, `backend/`, `skills/` (custom Agent OS skills), `tests/`.
- **1.2** Backend: project setup, health API, config (env for workspace path, Claude API key, optional Azure Speech key for TTS, OpenClaw state/config path for token ingestion).
- **1.3** OpenClaw workspace adapter:
  - Resolve workspace path (env or config).
  - Read/list: SOUL.md, AGENTS.md, MEMORY.md, optional IDENTITY.md, USER.md, TOOLS.md, `memory/*.md`.
  - Write with backup (e.g. `*.md.bak` or timestamped copy) and optional validation (e.g. max size, basic structure).
- **1.4** Frontend: app shell, routing, auth placeholder (e.g. single-user or API key).
- **1.5** API: `GET/PUT /workspace/files/:name` (e.g. soul, agents, memory) and `GET /workspace/files` (list).
- **1.6** Basic tests: adapter (read/write mock dir), API (file endpoints).

**Deliverable:** Backend and frontend run locally; you can open and save SOUL.md, AGENTS.md, MEMORY.md from the web UI.

---

### Phase 2: Org Chart & Activity Model (Weeks 2–3)

- **2.1** Data model: **agents** (id, name, role, parent_id, workspace_path, created_at), **activities** (id, agent_id, type, payload, created_at). Optional: **token_usage** (id, source e.g. openclaw, model_id, input_tokens, output_tokens, session_id, created_at) for later Phase 5 ingestion.
- **2.2** API: CRUD for agents (org chart); POST for activities (append-only log).
- **2.3** COO agent: mark one agent as “COO” (e.g. `role = 'COO'` or `is_coo = true`).
- **2.4** Frontend: org chart view (tree or flowchart); list of agents; placeholder for “activities” (list by agent). **Human–agent chat**: from org chart or agent list, user can open a chat with a selected agent; chat panel shows conversation history (current session) and input; each agent has its own conversation (session affinity by agent/workspace).
- **2.5** **Backend: agent chat proxy and OpenClaw chat adapter** — API: `POST /agents/:id/chat` (body: `{ message }`) returns agent reply; optionally `GET /agents/:id/chat` for recent turns. OpenClaw chat adapter: for each agent (workspace), send user message into that agent’s context and get reply (via OpenClaw gateway API, MCP, or subprocess/CLI); maintain session per agent so SOUL/AGENTS/MEMORY context is used. Optional: persist turns in DB for history and activity feed.
- **2.6** Optional: seed org from existing OpenClaw config or from a single default agent + COO.

**Deliverable:** Org chart editable in UI; activities can be recorded and listed per agent; human can interact with each OpenClaw agent separately via the web platform (1:1 chat per agent).

---

### Phase 3: Standups & COO Summarization (Weeks 3–4)

- **3.1** Data model: **standups** (id, scheduled_at, status, agent_ids, coo_notes, ceo_summary, created_at); **standup_responses** (standup_id, agent_id, content, submitted_at).
- **3.2** Standup flow:
  - Schedule (cron or manual): “daily standup” at configured time.
  - Backend creates standup record; notifies agents (webhook or in-app “standup due” — or simulated by posting prompts).
  - Agents “respond” via API (or via OpenClaw sessions that post to your API).
  - COO service runs: input = standup_responses + recent activities; uses Claude + **internal-comms** (and custom **agent-os-coo**) to produce standup summary and CEO digest.
- **3.3** Claude integration:
  - Call Anthropic API with `container` (skills: internal-comms, agent-os-coo).
  - Prompt: “Given these standup responses and activities, produce a standup summary and a one-paragraph CEO summary.”
- **3.4** API: `GET/POST /standups`, `GET/POST /standups/:id/responses`, `POST /standups/:id/run-coo` (or automatic after all responses).
- **3.5** Frontend: standup list, standup detail (responses + COO summary + CEO summary); “Run COO” button if manual.

**Deliverable:** Standups can be created and filled; COO produces summary and CEO digest via Claude + skills.

---

### Phase 4: CEO Summary & Reporting (Weeks 4–5)

- **4.1** CEO summary storage: store in `standups.ceo_summary` and optionally in a **reports** table (date range, type=ceo_daily, content).
- **4.2** Frontend: “CEO dashboard” — latest CEO summary; filter by date; optional export (markdown or, with docx skill, DOCX). "Listen" button: request TTS for selected summary; play audio in-browser (Microsoft free TTS).
- **4.3** **Voice summarization (Microsoft TTS)**:
  - Backend: integrate **Microsoft Azure Speech Services** (or free TTS endpoints); endpoint `POST /summaries/:id/tts` — generate audio from summary text, return stream or URL.
  - Use **free tier / free neural voices** where available (e.g. Azure free tier credit); support at least one language (e.g. en-US) and one voice.
  - Frontend: "Listen" button and audio player for CEO (and optionally standup) summary; optional "Download as MP3".
- **4.4** Reports: performance (e.g. tasks completed per agent, response times if you track them); coordination (handoffs, standup participation); activity history (table with filters, search).
- **4.5** Optional: **pdf** or **docx** skill to generate “Weekly CEO Report” (PDF/DOCX) from stored summaries and metrics.

**Deliverable:** CEO sees consolidated summary and basic reports; optional export; CEO (and optional standup) summaries available as voice via Microsoft TTS.

---

### Phase 5: Monitoring, Polish & Testing (Weeks 5–6)

- **5.1** Monitoring dashboard: charts for activity volume, standup completion, COO run success; simple health for Claude API and workspace. **Token usage monitoring (OpenClaw models)**: Ingest token usage from OpenClaw (session logs, gateway response metadata, or provider usage); persist to **token_usage** table (model_id, input_tokens, output_tokens, session/request id, timestamp). Dashboard: daily/weekly token totals by model; trend charts; optional cost estimate if price-per-token config is provided.
- **5.2** Audit log: who changed which MD file when (and optionally org chart changes); show in “Activity history” or admin.
- **5.3** E2E tests: use **webapp-testing** skill; Playwright flows: login → open org chart → edit SOUL.md → **open chat with an agent and send a message** → create standup → view CEO summary.
- **5.4** Security: auth (e.g. session or API key), rate limits, sanitize file paths (no escape outside workspace).
- **5.5** Deployment: Docker Compose (frontend build, backend, DB, env file); README with setup and env vars.

**Deliverable:** Production-ready Agent OS with monitoring, audit, E2E coverage, and deploy instructions.

---

## 5. Anthropic Skills Integration Detail

### 5.1 Using Official Skills (anthropics/skills)

- **Install/copy** from [anthropics/skills](https://github.com/anthropics/skills): e.g. `internal-comms`, `doc-coauthoring`, `webapp-testing`, `frontend-design`, optionally `docx`/`pdf`.
- **API usage:** pass skill folders via the Skills API (e.g. `container` or skill IDs per [Claude API skills guide](https://docs.anthropic.com/en/docs/build-with-claude/skills-guide)). Backend loads skill dirs and sends with Claude requests.
- **internal-comms:** Use for standup format and internal summary tone.
- **doc-coauthoring:** Use when generating or suggesting edits to AGENTS.md / SOUL.md / MEMORY.md (e.g. “suggest improvement to SOUL.md”).
- **webapp-testing:** Drive E2E test design and structure (selectors, flows).

### 5.2 Custom Skills (in Your Repo)

- **skills/agent-os-coo/SKILL.md**
  - Name: `agent-os-coo`
  - Description: When coordinating standups and producing CEO summaries for Agent OS: aggregate agent responses, list blockers, highlight decisions, and write a concise CEO paragraph.
  - Instructions: input schema (standup responses + activity snippets), output schema (standup summary + CEO summary), tone (executive, brief).

- **skills/agent-os-memory-editor/SKILL.md**
  - Name: `agent-os-memory-editor`
  - Description: When reading or proposing edits to OpenClaw SOUL.md, AGENTS.md, or MEMORY.md: preserve structure, suggest only safe edits, and never delete large sections without explicit confirmation.
  - Instructions: file purposes (SOUL = behavior, AGENTS = contract, MEMORY = facts), format rules, backup-before-write reminder.

Create these under `skills/` in the Agent OS repo and reference them in backend Claude calls together with official skills.

---

## 6. Voice Summarization (Microsoft TTS) — Scope

- **In scope:** CEO summaries (and optionally standup summaries) delivered as **spoken audio** using **Microsoft free TTS voice models**.
- **Options:** Use **Azure Speech Services** (TTS) with free tier / free neural voices (e.g. [Azure Speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)); new Azure accounts often get free credit. Prebuilt neural voices are available in many languages; choose at least one (e.g. en-US) for MVP.
- **Flow:** User clicks "Listen" on a summary → backend sends summary text to TTS API → returns audio stream (e.g. MP3) → frontend plays in-browser; optional "Download as MP3" for offline.
- **Config:** Backend env var for Azure Speech key (or equivalent); optional voice/locale selection in UI later.

---

## 7. Token Usage Monitoring (OpenClaw Models) — Scope

- **Goal:** Monitor **tokens used by the models behind OpenClaw** (input and output) for cost visibility, trends, and alerts.
- **Data to capture:** For each completion/request that OpenClaw uses: `model_id`, `input_tokens`, `output_tokens`, `session_id` (or request id), `timestamp`. Optionally provider (e.g. anthropic, openai) and workspace/agent id.
- **Ingest:** Wherever OpenClaw or its gateway exposes usage (e.g. response metadata, session logs, `sessions.json`, or a small sidecar that parses logs), the Agent OS backend ingests and persists to a **token_usage** table.
- **Dashboard:** Daily/weekly token totals by model; time-series charts; optional cost estimate if admin configures price-per-token per model.
- **References:** OpenClaw session/compaction and provider usage may appear in state dir (e.g. `~/.openclaw`); check OpenClaw docs for usage or logging hooks.

---

## 8. OpenClaw MD File Management (Detail)

- **Mapping:**  
  - `soul` → SOUL.md  
  - `agents` → AGENTS.md  
  - `memory` → MEMORY.md  
  - Optional: `identity` → IDENTITY.md, `user` → USER.md, `tools` → TOOLS.md  
  - `memory/daily` → list + read/write `memory/YYYY-MM-DD.md`
- **Read:** GET returns raw markdown; support optional `?format=html` (backend renders MD to HTML) for preview.
- **Write:** PUT body = raw markdown; backend writes to workspace and creates backup; return 200 + updated content.
- **Validation:** Max file size (e.g. 500 KB); optional basic frontmatter or section checks for SOUL/AGENTS.
- **Multi-workspace (later):** If supporting multiple OpenClaw workspaces, add `workspace_id` or path in URL and in adapter.

---

## 9. Human–Agent Interaction (Direct Chat) — Scope

- **In scope:** The human (CEO/user) can **interact with each OpenClaw agent separately** in the web platform: choose an agent from the org chart or list, open a 1:1 chat, send messages and receive replies. Each agent uses its own workspace context (SOUL.md, AGENTS.md, MEMORY.md).
- **UI:** Per-agent chat panel or page; conversation history for the current session; message input; clear indication of which agent is being chatted with.
- **Backend:** Chat proxy that routes `POST /agents/:id/chat` to the correct OpenClaw agent. **OpenClaw chat adapter** must send the user message into that agent’s session and return the agent’s reply. Implementation options (depending on what OpenClaw provides):
  - **OpenClaw gateway/HTTP API** — if OpenClaw exposes a REST or WebSocket endpoint for chat, the backend calls it with the agent/workspace id and message.
  - **MCP** — if OpenClaw is exposed via MCP, the backend uses the MCP client to invoke the agent with the message.
  - **Subprocess / CLI** — as fallback, backend may spawn OpenClaw CLI with the workspace path and pass the message (e.g. stdin or a temp file), then capture stdout; session affinity can be maintained by keeping a long-lived process per agent or by rehydrating from workspace memory each time.
- **Session affinity:** One conversation session per agent (per user) so that multi-turn context is preserved for that agent’s SOUL/AGENTS/MEMORY.
- **Optional:** Persist chat turns in the Agent OS DB for history, activity feed, and audit.

---

## 10. References

| Resource | URL / Note |
|----------|------------|
| OpenClaw memory | https://docs.openclaw.ai/concepts/memory |
| OpenClaw memory files (AGENTS, SOUL, MEMORY) | https://openclaw-setup.me/blog/openclaw-memory-files/ |
| Anthropic skills repo | https://github.com/anthropics/skills |
| Agent Skills spec | https://agentskills.io (and repo `spec/`, `template/`) |
| Claude API skills | https://docs.anthropic.com/en/docs/build-with-claude/skills-guide |
| Internal-comms / doc skills | anthropics/skills (internal-comms, doc-coauthoring, docx, pdf) |
| Webapp-testing skill | anthropics/skills (webapp-testing) for E2E |
| Microsoft Azure Speech (TTS) | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech; free tier / free neural voices |

---

## 11. Success Criteria

- CEO can open one dashboard and see standup summaries and a clear CEO digest.
- **Human–agent interaction:** Human (CEO/user) can interact with each OpenClaw agent separately in the web platform: select an agent, open a 1:1 chat, send messages and receive replies in that agent’s context.
- All OpenClaw memory files (SOUL.md, AGENTS.md, MEMORY.md) are viewable and editable from the web with backups.
- Org chart reflects agents and COO; activities and standups are recorded and queryable.
- COO summarization runs via Claude using Anthropic + custom skills.
- Reports show performance and coordination; activity history is auditable.
- **Voice:** CEO (and optional standup) summaries can be played as audio via Microsoft free TTS.
- **Token monitoring:** Token usage for models behind OpenClaw is ingested, stored, and visible in the dashboard (by model, over time; optional cost).
- E2E tests cover main flows; deployment is documented (e.g. Docker Compose + env).

---

## 12. Next Steps

1. Create repo structure (`frontend/`, `backend/`, `skills/`, `tests/`).
2. Implement Phase 1 (workspace adapter + MD CRUD API + minimal frontend).
3. Clone/copy chosen Anthropic skills and add custom `agent-os-coo` and `agent-os-memory-editor`.
4. Proceed through Phases 2–5 in order, with testing and deployment in Phase 5.

If you want, next we can turn this into a concrete task list (e.g. in GitHub Issues) or generate initial code stubs for Phase 1 (backend + adapter + one frontend page).
