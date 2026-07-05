# Session history "forbidden" — visibility restricted to tree

## Error

When TechResearcher (or another agent) calls **sessions_history**, you may see:

```json
{
  "status": "forbidden",
  "error": "Session history visibility is restricted to the current session tree (tools.sessions.visibility=tree)."
}
```

## Cause

OpenClaw can restrict session tools so an agent only sees sessions in its **current session tree**. With `tools.sessions.visibility=tree`:

- When the agent runs in a **delegation** or **Kanban** run, its session is e.g. `delegation-123` or `kanban-456` (a different “tree” than the Dashboard `main` session).
- If the agent then calls **sessions_history** with `sessionKey: "agent::techresearcher:main"`, that key is in a different tree → **forbidden**.

## Fixes

### 1. Use the injected session key (recommended)

Agent OS injects the correct session key into the prompt for each run, e.g.:

`Your session key for this run is agent::techresearcher:delegation-123. Use this exact sessionKey when calling sessions_history.`

The agent’s SOUL should tell it to **use that key when present**, and only fall back to `agent::techresearcher:main` for Dashboard chat. TechResearcher and ExpenseManager SOULs in `openclaw-workspace-templates` have been updated accordingly. Copy the latest SOUL into the agent’s workspace (or re-apply the template) so delegated/Kanban runs use the injected key and stay within the same tree.

### 2. Relax visibility in OpenClaw config (optional)

If you want agents to be able to read **any of their own** sessions (e.g. both `main` and `delegation-*`) regardless of tree, set in **`~/.openclaw/openclaw.json`**:

```json
{
  "tools": {
    "sessions": {
      "visibility": "agent"
    }
  }
}
```

(If your config already has a top-level `gateway` or `agents`, add this `tools` block alongside them.)

Then **restart the OpenClaw gateway** so it picks up the change. If you still see the error when testing **directly in OpenClaw** (Dashboard / session chat), set `"visibility": "all"` instead of `"agent"`. Run `node scripts/fix-session-visibility-and-restart-gateway.js` from agent-os to set `all` and then restart the gateway.

## Summary

- **Tree visibility**: agent can only access sessions in the current run’s tree.
- **Fix 1**: SOUL says “use the session key from the message when present” → no cross-tree access needed.
- **Fix 2**: Set `tools.sessions.visibility` to `"agent"` (or `"all"`) in `~/.openclaw/openclaw.json` and restart the gateway.
