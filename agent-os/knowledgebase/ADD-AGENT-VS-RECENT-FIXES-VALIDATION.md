# Add Agent UI vs. Recent Fixes — Validation

**Purpose:** Recollect the fixes applied for agent session history, tools, SOUL, and Kanban; compare with the **Add Agent** UI flow; validate whether newly created agents (via Add Agent) get the same behavior. **No code changes** — validation only.

---

## 1. Recollect: Fixes done so far for agents

### 1.1 Session history

| Fix | Where | What |
|-----|--------|------|
| **Visibility** | `~/.openclaw/openclaw.json` | `tools.sessions.visibility` set to `"agent"` or `"all"` so agents can read session history (avoid “restricted to current session tree” forbidden). |
| **Injected session key** | Backend (kanban, delegation-queue, standup-delegate, broadcast, cron) | Prompt includes: “Your session key for this run is `agent::<id>:<sessionUser>`. Use this exact sessionKey when calling sessions_history.” |
| **Empty history fallback** | Same backend paths | “If sessions_history returns empty, the conversation is in the messages above—proceed with those.” |
| **Exact session key at gateway** | `backend/src/gateway/openclaw.js` | When `sessionUser` is set, request sends header `x-openclaw-session-key: agent::<id>:<sessionUser>` so the gateway stores under that key. |
| **SOUL instructions** | `openclaw-workspace-templates/techresearcher/SOUL.md`, `expensemanager/SOUL.md` | Use the session key from the message when present; otherwise use `agent::<id>:main` for Dashboard chat. |

### 1.2 Tools availability

| Fix | Where | What |
|-----|--------|------|
| **Per-agent tools** | `~/.openclaw/openclaw.json` → `agents.list[].tools.allow` | Each agent (TechResearcher, ExpenseManager, etc.) has an explicit allowlist (e.g. summarize_url, kanban_move_status, forex_rates, intent_classify_and_delegate). |
| **Agent OS content tools** | Plugin `agent-os-content-tools` | Tools are registered with the gateway; backend serves invoke; `openclaw.json` has `plugins.entries["agent-os-content-tools"].config.baseUrl`. |
| **Onboard new API tool** | `scripts/onboard-api-tool.js` | Adds tool to DB (`content_tools_meta`), writes `agent-os-tools.json`, merges into `openclaw.json` and `agent-os-tool-overrides.json` so only `applicable_agents` get the tool. |
| **Apply config** | `scripts/apply-openclaw-agents-config.js` | Ensures `agents.list` and per-agent `tools.allow` (and optional `tools.deny`) are set in `openclaw.json`. |

### 1.3 Standard SOUL / tool fallback

| Fix | Where | What |
|-----|--------|------|
| **Session history in SOUL** | Templates (techresearcher, expensemanager, bala, balserve) | “Before responding: get your session history … use session key from message when present, else agent::<id>:main.” |
| **Tool choice / fallback** | Same SOULs | “Pick the tool that best matches the user’s request (see TOOLS.md). If a tool’s response is inadequate, try the next best tool instead of stopping.” |
| **Kanban workflow (direct-assign)** | `backend/src/routes/kanban.js` | For tasks with `assigned_agent_id` and **no** `agent_delegation_task_id`, prompt injects: “FIRST ACTION: call kanban_move_status in_progress” and “When you are done, call completed or failed.” |

### 1.4 Skills

| Item | Where | What |
|------|--------|------|
| **agent-send** | `openclaw-skills/agent-send` | sessions_list, sessions_send, sessions_history — enabled in `openclaw.json` under `skills.entries`. |
| **agent-os-content-tools** | Plugin + skill | Content tools (summarize_url, etc.) and Kanban tools; enabled in plugins/skills. |

---

## 2. Add Agent UI flow (current behavior)

### 2.1 Frontend

- **Location:** Dashboard → “Add agent” section.
- **Fields:** Agent name (required), Role (optional), Report to (optional, parent_id).
- **Submit:** `api.agentCreate(body)` with `{ name, role, parent_id? }`.

### 2.2 Backend POST /api/agents

- **Body used:** `name`, `role`, `parent_id` (optional). No `id`, `workspace_path`, `openclaw_agent_id`, or `is_coo` from the form.
- **Defaults:**  
  - `id` = `agent-${Date.now()}`  
  - `openclaw_agent_id` = **`'main'`**  
  - `workspace_path` = **`null`**  
  - `is_coo` = 0  
- **Effect:** A single row is inserted into the `agents` table. Nothing else is created or updated.

### 2.3 What Add Agent does **not** do

- Does **not** add the agent to `~/.openclaw/openclaw.json` `agents.list`.
- Does **not** create a workspace dir or SOUL.md / AGENTS.md / MEMORY.md.
- Does **not** set `openclaw_agent_id` to the new agent’s id (it stays `'main'`).
- Does **not** set `workspace_path`.
- Does **not** assign any tools (no `agents.list[].tools.allow`).
- Does **not** create `~/.openclaw/agents/<id>/sessions` or any OpenClaw agent dirs.
- Does **not** install or reference any skills for the new agent.

---

## 3. Comparison: Add Agent vs. “fully set up” agents

| Concern | Recent fixes (for existing agents) | Add Agent UI |
|--------|-------------------------------------|--------------|
| **Session history** | Injected key + SOUL instructions + visibility in config. | No SOUL; no workspace; agent not in OpenClaw. Session key injection in backend would still run for chat/Kanban but gateway has no agent by that id. |
| **Tools** | Per-agent allow in openclaw.json + plugin. | New agent not in openclaw.json → no tools assigned. |
| **Tool fallback** | SOUL says “try next best tool.” | No SOUL → no such instruction. |
| **Kanban instructions** | Injected for direct-assigned tasks. | Backend would inject if task.assigned_agent_id = new agent id, but gateway would not know the agent (not in openclaw.json). |
| **Skills** | agent-send, content-tools enabled in config. | Config not updated for new agent; skills apply to agents known to OpenClaw. |
| **Workspace / SOUL** | Templates with session + tool-choice text. | No workspace, no SOUL. |

So: **Add Agent creates a DB-only record.** It does **not** map the new agent to OpenClaw, tools, skills, or standard SOUL/session behavior.

---

## 4. How “proper” agents get mapped (reference)

- **Script path:** `backend/scripts/create-openclaw-agent.js` with an agent-def JSON:
  - Creates workspace dir, SOUL.md/AGENTS.md/MEMORY.md (and optional TOOLS.md).
  - Appends/updates `agents.list` in openclaw.json (id, name, workspace).
  - Ensures `tools.agentToAgent.allow` includes the id.
  - Creates `~/.openclaw/agents/<id>/agent` and `sessions` (sessions.json).
  - Inserts/updates DB row with `workspace_path`, `openclaw_agent_id` = id.
- **Config script:** `scripts/apply-openclaw-agents-config.js` sets per-agent `tools.allow` (and optional deny) for known agents.
- **Onboard tool:** `scripts/onboard-api-tool.js` adds a new API tool and assigns it to `applicable_agents` via overrides + openclaw.json.
- **Dashboard “Load OpenClaw agents” / “Pull all into DB”:** Syncs **from** openclaw.json **into** the DB (id, name, workspace_path, openclaw_agent_id). Does not create new agents in OpenClaw; it only pulls existing ones into the org chart.

So: **New agents that should have session history, tools, and standard SOUL are expected to be created via `create-openclaw-agent.js` (or manual openclaw.json + workspace + SOUL), then optionally synced into the DB via Dashboard or API.**

---

## 5. Validation summary

- **Session history, tools, tool fallback, Kanban instructions:** All recent fixes apply to agents that exist in OpenClaw (in openclaw.json with workspace and, where used, SOUL with the new instructions).
- **Add Agent UI:** Only adds a row to the agents table with `openclaw_agent_id = 'main'` and no workspace. It does **not**:
  - Create or update openclaw.json.
  - Create a workspace or SOUL.
  - Assign tools or skills.
  - Provide session-history or tool-choice instructions.

**Conclusion:** The Add Agent flow is **not** aligned with the recent fixes. Newly created agents via Add Agent do **not** get the right tools, skills, or standard SOUL/session behavior. To have a new agent behave like TechResearcher/ExpenseManager (session history, tools, fallback, Kanban), the user must create the agent outside this UI (e.g. `create-openclaw-agent.js` with a def file that includes session/tool SOUL, then apply tools/skills via config/onboard scripts and optionally sync into DB via “Load OpenClaw agents” / “Pull all into DB”).

---

## 6. Suggested follow-ups (for later, not in scope of this validation)

- Document in the UI or knowledgebase that “Add agent” is for DB-only org chart entries and that full OpenClaw agents are created via `create-openclaw-agent.js` (and tools/onboard as needed).
- Or extend the Add Agent flow to optionally create an OpenClaw agent (openclaw.json + workspace + default SOUL from template) and set `openclaw_agent_id` and `workspace_path`, then apply a default tool allowlist (e.g. same as TechResearcher) so new agents get tools and session behavior by default.
