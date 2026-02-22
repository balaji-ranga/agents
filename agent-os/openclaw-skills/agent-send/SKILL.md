---
name: agent-send
description: Send messages to other OpenClaw agents and read their session history (sessions_list, sessions_history, sessions_send).
metadata:
  {
    "openclaw": { "emoji": "📤" }
  }
---

# Agent-send skill

Use this skill to communicate with other agents in the same OpenClaw gateway.

## When to use

- **COO (BalServe)**: Delegate tasks to TechResearcher or ExpenseManager; send instructions and wait for replies.
- **Any agent**: Send a message to another agent’s session, read another session’s history, or list active sessions.

## Tools

- **sessions_list** — List active sessions. Parameters: `messageLimit` (0 = no messages), `activeMinutes`, `limit`, `kinds`. Use to discover other agents’ session keys (e.g. `agent::techresearcher:main`).
- **sessions_history** — Read the transcript of one session. Parameters: `sessionKey` (required), `includeTools`, `limit`. Use when you need context from another agent’s conversation.
- **sessions_send** — Send a message into another session. Parameters: `sessionKey` (required), `message` (required), `timeoutSeconds` (0 = fire-and-forget; >0 = wait for reply). Use to delegate work or ask another agent a question.

## Session keys

- Main chat for an agent: `agent::<agentId>:main` (e.g. `agent::techresearcher:main`, `agent::expensemanager:main`, `agent::balserve:main`, `agent::bala:main`).
- Get exact keys from `sessions_list` if needed.

## Guidelines

- Prefer `sessions_send` with `timeoutSeconds > 0` when you need a reply from the other agent.
- Use `timeoutSeconds: 0` for fire-and-forget notifications.
- Use `sessions_history` only when you need prior context; avoid unnecessary reads.
