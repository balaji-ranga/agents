# OpenClaw COO and Multi-Agent Setup

This doc describes the **multi-agent routing** setup so the **COO (BalServe)** can communicate with other agents (TechResearcher, ExpenseManager, Bala) using OpenClaw session tools (`sessions_list`, `sessions_send`, `sessions_history`). All agents get the **agent-send** skill.

Reference: [OpenClaw Multi-Agent Routing](https://docs.openclaw.ai/concepts/multi-agent), [Session Tools](https://docs.openclaw.ai/concepts/session-tool).

## 1. Apply OpenClaw config (agents + agent-to-agent)

Config is written to `~/.openclaw/openclaw.json`:

- **agents.list**: Bala (default), COO (balserve), TechResearcher (techresearcher), ExpenseManager (expensemanager), each with its own workspace.
- **tools.agentToAgent**: `enabled: true`, `allow: ["bala", "balserve", "techresearcher", "expensemanager"]` so every agent can use session tools to talk to the others.

From `agent-os`:

```powershell
node scripts/apply-openclaw-agents-config.js
```

Restart the gateway after changing config.

## 2. Ensure agent dirs

Each agent needs `~/.openclaw/agents/<id>/agent` and `.../sessions`. This includes bala, balserve, techresearcher, expensemanager:

```powershell
node scripts/ensure-openclaw-agent-dirs.js
```

## 3. COO Soul and AGENTS (knows other agents)

The COO workspace should have SOUL.md and AGENTS.md that describe its role and list the other agents and how to reach them (session keys, e.g. `agent::techresearcher:main`).

Templates live in `openclaw-workspace-templates/balserve/`. To write them into the COO workspace:

```powershell
cd backend
node scripts/ensure-coo-workspace.js
```

This writes SOUL.md and AGENTS.md into OPENCLAW_WORKSPACE_BALSERVE (default `~/.openclaw/workspace-balserve`). Edit those files there if you need to customize.

## 4. Agent-send skill (all agents)

The **agent-send** skill teaches agents to use `sessions_list`, `sessions_history`, and `sessions_send`. Install it into the shared OpenClaw skills folder so **all** agents see it:

```powershell
node scripts/install-agent-send-skill.js
```

This copies `openclaw-skills/agent-send/` to `~/.openclaw/skills/agent-send/`. Restart the gateway so agents pick up the skill.

## 5. Full setup order

1. `node scripts/apply-openclaw-agents-config.js`
2. `node scripts/ensure-openclaw-agent-dirs.js`
3. `cd backend && node scripts/ensure-coo-workspace.js`
4. `node scripts/install-agent-send-skill.js`
5. Restart the gateway: `openclaw gateway --port 18789` (or your port).

## Bindings (optional)

**Bindings** in OpenClaw route channel traffic (WhatsApp, Telegram, Discord) to specific agents. Agent OS chat uses the HTTP API with `x-openclaw-agent-id`, so bindings are not required for the web dashboard. If you add channels later, add bindings in `~/.openclaw/openclaw.json` under `bindings` (see Multi-Agent Routing docs).

## Summary

| Item | Purpose |
|------|--------|
| agents.list | Bala, COO, TechResearcher, ExpenseManager with workspaces |
| tools.agentToAgent | Allows sessions_send / sessions_list / sessions_history between these agents |
| COO SOUL.md / AGENTS.md | COO knows other agents and how to delegate via sessions_send |
| agent-send skill | All agents have the skill; COO and others can send to each other |
