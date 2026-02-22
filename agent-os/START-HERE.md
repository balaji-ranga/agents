# Start Agent OS (gateway + backend + frontend)

## Make BalServe and TechResearcher available

1. **Seed the database** (from backend folder):
   ```powershell
   cd c:\Users\balaj\projects\agents\agent-os\backend
   node scripts/seed-all.js
   ```
   This registers BalServe (COO) and TechResearcher and adds one sample standup.

2. **OpenClaw gateway** — Start (or restart) the gateway so the backend can reach it:
   ```powershell
   openclaw gateway --port 18789
   ```
   For per-agent workspaces (BalServe vs TechResearcher), ensure `~/.openclaw/openclaw.json` has an `agents.list` with each agent’s `id` and `workspace` path. See `OPENCLAW-GATEWAY-AGENTS.md`. Restart the gateway if it was already running.

3. **Backend** and **frontend** — Start as below. The Dashboard will show the org chart (CEO → COO → delegated agents), daily standups summary, and Listen (Microsoft Edge TTS) for summaries.

## Current status

- **OpenClaw gateway** — **running** at `http://127.0.0.1:18789` (chat completions enabled). A token was auto-generated and saved in `agent-os/backend/.env` as `OPENCLAW_GATEWAY_TOKEN`.
- **Backend** and **frontend** — need to be started from **your own terminal** (npm install may hit EPERM in automated environments).

## One-time: install dependencies

In a normal PowerShell or CMD window (not sandboxed):

```powershell
cd c:\Users\balaj\projects\agents\agent-os\backend
npm install

cd c:\Users\balaj\projects\agents\agent-os\frontend
npm install
```

If `better-sqlite3` fails on Windows, run the same in an **elevated** (Run as administrator) terminal, or use WSL.

## Start all three (after npm install)

**Option A — use the script (opens 3 windows):**

```powershell
cd c:\Users\balaj\projects\agents\agent-os
.\start-all.ps1
```

**Option B — start manually in 3 terminals:**

1. **Gateway** (if not already running):
   ```powershell
   openclaw gateway --port 18789
   ```

2. **Backend:**
   ```powershell
   cd c:\Users\balaj\projects\agents\agent-os\backend
   npm run dev
   ```

3. **Frontend:**
   ```powershell
   cd c:\Users\balaj\projects\agents\agent-os\frontend
   npm run dev
   ```

Then open **http://127.0.0.1:3000** in your browser.
