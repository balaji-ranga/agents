# OpenClaw Gateway Dashboard — Bala, COO, TechResearcher, ExpenseManager

The **OpenClaw gateway dashboard** (http://127.0.0.1:18789) shows agents from `agents.list` in **`~/.openclaw/openclaw.json`**. That config has been updated so the agents menu shows:

- **Bala** (default agent, workspace: `~/.openclaw/workspace`)
- **COO** (BalServe, workspace: `~/.openclaw/workspace-balserve`)
- **TechResearcher** (workspace: `~/.openclaw/workspace-techresearcher`)
- **ExpenseManager** (workspace: `~/.openclaw/workspace-expenses`)

For **COO multi-agent routing** (COO talking to other agents via sessions_send) and the **agent-send** skill for all agents, see **[OPENCLAW-COO-MULTI-AGENT.md](OPENCLAW-COO-MULTI-AGENT.md)**.

## What was done

1. **Config applied** — `scripts/apply-openclaw-agents-config.js` wrote `agents.list`, `tools.agentToAgent` (so COO and others can use sessions_send), and gateway defaults to `~/.openclaw/openclaw.json`. Existing keys (e.g. channels, auth) were kept; only `agents`, `tools.agentToAgent`, and gateway defaults were set/merged.

2. **Agent dirs** — The gateway needs a directory per agent under `~/.openclaw/agents/<id>/agent` and `.../sessions`. The script creates them for `bala`, `balserve`, `techresearcher`, and `expensemanager`. To re-create: `node scripts/ensure-openclaw-agent-dirs.js`.

3. **Required MD files** — Each agent workspace has SOUL.md, AGENTS.md, MEMORY.md (and optional IDENTITY.md, USER.md, TOOLS.md). Bala’s workspace had MEMORY.md added; COO and TechResearcher already had all three.

4. **Restart required** — The gateway must be restarted (or started) after config or agent-dir changes so the dashboard can interact with all agents.

## Start or restart the gateway

If the gateway is **not** running:

```powershell
openclaw gateway --port 18789
```

If it **is** running (in another terminal):

- Stop it with **Ctrl+C**, then run the same command again, or
- If you installed it as a service: `openclaw gateway restart` (or use the Windows Task Scheduler task if you created one).

Then open **http://127.0.0.1:18789** and check the **Agents** menu for Bala, COO, and TechResearcher.

## Re-apply config later

To re-apply the four agents and gateway defaults (e.g. after editing openclaw.json by hand):

```powershell
cd c:\Users\balaj\projects\agents\agent-os
node scripts/apply-openclaw-agents-config.js
```

Then restart the gateway as above.

To apply and restart in one step (if gateway is installed as a service):

```powershell
.\scripts\apply-openclaw-agents-and-restart.ps1
```

## Making agents interactable (if dashboard shows them but chat does not work)

If the dashboard lists Bala, COO, TechResearcher but you cannot start a chat or get a reply:

1. **Ensure agent dirs exist** for COO and TechResearcher:
   ```powershell
   cd c:\Users\balaj\projects\agents\agent-os
   node scripts/ensure-openclaw-agent-dirs.js
   ```
2. **Restart the gateway** (stop with Ctrl+C, then `openclaw gateway --port 18789`).
3. In the dashboard, choose an agent from the agents menu and send a message again.

## Test agents directly in OpenClaw (CLI)

To confirm each agent loads its workspace and MD files and replies correctly:

```powershell
# Test COO (BalServe) — expects a one-sentence role reply
openclaw agent --agent balserve -m "What is your role? Reply in one short sentence." --local --json

# Test TechResearcher — expects a one-sentence role reply
openclaw agent --agent techresearcher -m "What is your role? Reply in one short sentence." --local --json

# Test Bala (default)
openclaw agent --agent bala -m "What is your role? Reply in one short sentence." --local --json

# Test ExpenseManager
openclaw agent --agent expensemanager -m "What is your role? Reply in one short sentence." --local --json
```

`--local` runs the agent locally (using your configured model/API keys); omit it to run via the gateway. Successful runs show `payloads[0].text` with the agent’s reply and `injectedWorkspaceFiles` including SOUL.md, AGENTS.md, MEMORY.md for that agent’s workspace.
