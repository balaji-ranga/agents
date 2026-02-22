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
   Use “Add agent” on the Dashboard: enter name and role, submit. The new agent appears in the org chart (under delegated if it has a parent, or add parent later).

3. **Schedule standups**  
   In “Daily standups summary”, click “Create standup”. A new standup appears in the list. Select it to see COO summary / CEO summary (empty until “Run COO” is used).

4. **Updating MD files**  
   Open an agent’s Workspace (from Dashboard or Workspace (MD) page). Select soul, agents, or memory; edit the text and click Save. Reload to confirm persistence.

5. **Summary (Run COO)**  
   Select a standup, optionally add responses via API, then click “Run COO”. COO summary and CEO summary should appear (requires ANTHROPIC_API_KEY in backend .env). Use “Listen (Edge TTS)” to hear the summary.

6. **Human–agent interaction**  
   From the Dashboard or Workspace page, open “Chat” for an agent. Send a message; the reply appears (requires OpenClaw gateway running and agent workspace/agent dir set up).

## Smoke test (quick)

```powershell
cd backend
npm run test:smoke
```

Runs GET /health, GET /agents, GET /standups. Backend must be running.
