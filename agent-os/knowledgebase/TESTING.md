# Agent OS — Testing

## Restart services before testing

Restart **backend**, **frontend**, and **OpenClaw gateway** so the latest code and config are loaded:

1. **Backend** (port 3001): stop any running process (Ctrl+C), then:
   ```powershell
   cd c:\Users\balaj\projects\agents\agent-os\backend
   npm run dev
   ```
2. **Frontend** (port 3000): stop, then:
   ```powershell
   cd c:\Users\balaj\projects\agents\agent-os\frontend
   npm run dev
   ```
3. **OpenClaw gateway** (port 18789): stop, then:
   ```powershell
   openclaw gateway --port 18789
   ```
   Or use **start-all.ps1** from `agent-os` to open all three in separate windows.

## Full API test (all features)

From the **agent-os** folder (or with `BASE_URL` set):

```powershell
node tests/api-full.js
```

This covers:

- **Health** — GET /health
- **Agents** — GET /agents, POST /agents (new agent creation), GET /agents/:id
- **Standups** — GET /standups, POST /standups (schedule standup), GET /standups/:id, POST /standups/:id/run-coo (summary)
- **Agent workspace (MD files)** — GET /agents/:id/workspace/files, GET .../files/:name (read), PUT .../files/:name (update MD)
- **Human–agent** — GET /agents/:id/chat (history), POST /agents/:id/chat (send message)

Optional env:

- `SKIP_RUN_COO=1` — skip Run COO (needs ANTHROPIC_API_KEY in backend .env).
- `SKIP_CHAT=1` — skip chat send (needs OpenClaw gateway running).
- `BASE_URL=http://127.0.0.1:3001` — backend URL (default when frontend proxy is not used).

## Frontend test cases (manual)

After opening http://127.0.0.1:3000:

1. **Dashboard — Org chart**  
   Agent names and roles come from the DB (no hardcoded names). You should see CEO (me) and, under it, the COO agent (name + role from DB) and delegated agents.

2. **New agent creation**  
   Use "Add agent" on the Dashboard: enter name and role, submit. The new agent appears in the org chart (under delegated if it has a parent, or add parent later).

3. **Schedule standups**  
   In "Daily standups summary", click "Create standup". A new standup appears in the list. Select it to see COO summary / CEO summary (empty until "Run COO" is used).

4. **Updating MD files**  
   Open an agent's Workspace (from Dashboard or Workspace (MD) page). Select soul, agents, or memory; edit the text and click Save. Reload to confirm persistence.

5. **Summary (Run COO)**  
   Select a standup, optionally add responses via API, then click "Run COO". COO summary and CEO summary should appear (requires ANTHROPIC_API_KEY in backend .env). Use "Listen (Edge TTS)" to hear the summary.

6. **Human–agent interaction**  
   From the Dashboard or Workspace page, open "Chat" for an agent. Send a message; the reply appears (requires OpenClaw gateway running and agent workspace/agent dir set up).

## Smoke test (quick)

```powershell
cd backend
npm run test:smoke
```

Runs GET /health, GET /agents, GET /standups. Backend must be running.

---

## Standup → COO → TechResearcher test

This test validates: **COO had a standup with inputs on topics for LinkedIn "AI for Finance industry" → COO messages TechResearcher to do research and come back with topics → COO summarizes for CEO Bala.**

### Prerequisites

- **Backend** running (`cd backend && npm run dev`)
- **OpenClaw gateway** running (`openclaw gateway --port 18789`) so TechResearcher can reply
- **OPENAI_API_KEY** set in backend `.env` for COO summarization
- TechResearcher and COO (BalServe) in DB: run `node scripts/ensure-techresearcher.js` and `node scripts/seed-all.js` if needed

### Run automated test

From the **backend** folder:

```bash
node scripts/run-standup-research-test.js
```

Steps performed:

1. Create standup with topic: AI for Finance industry (LinkedIn research).
2. Add standup response (topics for research for LinkedIn).
3. Run COO summarization on standup (requires OPENAI_API_KEY).
4. COO messages TechResearcher via `POST /agents/techresearcher/chat/from-agent` (requires gateway).
5. Add TechResearcher reply to standup and run COO again for CEO summary.

View the standup in the Dashboard at http://127.0.0.1:3000.

### Manual alternative

1. **Dashboard** → Create standup (pick date/time) → add a response with content: "Topics for research for publish to LinkedIn: AI for Finance industry."
2. Click **Run COO** to get COO/CEO summary.
3. **Chat** → open TechResearcher → send: "From our standup we need research and 3–5 talking points for a LinkedIn post on AI for Finance industry. Please research and reply with angles we can use."
4. Copy TechResearcher's reply, add it as another response to the standup (or create a new standup), then **Run COO** again for the final summary for Bala.

### Agent-to-agent (COO → TechResearcher)

The backend supports **COO messaging TechResearcher** via:

- **API:** `POST /agents/techresearcher/chat/from-agent` with body `{ "from_agent_id": "balserve", "message": "..." }`
- **Frontend:** use `api.agentChatFromAgent('techresearcher', 'balserve', message)` (e.g. from a "Send from COO" button).

The message is stored in TechResearcher's chat as "From BalServe (COO): ..." and the reply is returned and persisted.

---

## Standup flow — UI test checklist

Test from the **Dashboard** in the browser. No backend scripts required.

### Prerequisites

- Backend and frontend running. All API routes are under `/api`; the frontend proxies `/api` to the backend (or set `VITE_API_URL` to the backend base URL including `/api`).
- OpenClaw Gateway running (for COO chat and for "Get work from team" — delegation uses Gateway cron one-shot jobs that POST to the backend webhook).
- At least one agent in the org with COO set, and at least one delegated agent (e.g. TechResearcher).

### 1. Create standup → COO chat opens

- [ ] Open **Dashboard**.
- [ ] In **Standups**, set date/time and click **Create standup**.
- [ ] Right side shows **COO chat — [date/time]** and an empty message area.
- [ ] Placeholder text: "No messages yet. Send the day's tasks to the COO below."

### 2. Chat is specific to that standup

- [ ] Send a message in the chat (e.g. "Focus on research today").
- [ ] You see **You:** and **COO:** messages in the same chat.
- [ ] Select a **different** standup from the list (or create another).
- [ ] Chat content changes; the new standup has its own (possibly empty) history.
- [ ] Select the first standup again; your earlier messages and COO replies are still there.

### 3. Get work from team → updates in chat

- [ ] With a standup selected, click **Get work from team**.
- [ ] A COO reply appears in the chat (e.g. "I've asked the team...").
- [ ] Click **Check for updates** (or wait for cron to run).
- [ ] New COO messages appear in the **same** chat with agent updates (when cron has run and agents have responded).

### 4. Optional summary

- [ ] **Run COO summary** runs without error (may need agent responses in standup_responses for non-empty summary).
- [ ] If a summary exists, **Listen** reads it; **Summary** details section can be expanded to read COO/CEO text.

### 5. Open existing scheduled standup

- [ ] With at least one standup in the list, click it (do not create a new one).
- [ ] COO chat opens for that schedule with that standup's messages only.
- [ ] Sending a message and using **Get work from team** / **Check for updates** keeps everything in this standup's chat.

**Expected flow:** Create or open standup → COO chat is the main view → give tasks in chat → COO delegates via cron → child agent responses show up in this chat. Each standup has its own chat history.
