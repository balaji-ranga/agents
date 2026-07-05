# agent-os-content-tools (shared skill)

This skill is installed into **~/.openclaw/skills/agent-os-content-tools** so all agents can use it (shared skill).

## Tools provided

| Tool           | Backend endpoint                    | Phase  |
|----------------|-------------------------------------|--------|
| summarize_url  | POST /api/tools/summarize-url       | ✅ 1   |
| generate_image | POST /api/tools/generate-image      | 2      |
| generate_video  | POST /api/tools/generate-video      | 3      |

## Configuration (no hardcoded URLs)

- **AGENT_OS_API_URL** — Backend base URL (e.g. `http://127.0.0.1:3001`). Set in environment or OpenClaw config where the skill runs.
- **TOOLS_API_KEY** — Optional. If set in the backend `.env`, set the same value where the skill can use it so requests send `Authorization: Bearer <TOOLS_API_KEY>`.

## Install (shared)

1. **Copy the skill** to OpenClaw’s shared skills folder (from the agent-os repo):

   ```bash
   node scripts/install-agent-os-content-tools-skill.js
   ```

2. **Enable the skill** in OpenClaw config so it appears in the dashboard. Either:
   - Run the full config apply (this enables both agent-send and agent-os-content-tools):
     ```bash
     node scripts/apply-openclaw-agents-config.js
     ```
   - Or manually add to `~/.openclaw/openclaw.json` under `skills.entries`:
     ```json
     "skills": {
       "entries": {
         "agent-os-content-tools": { "enabled": true }
       }
     }
     ```

3. **Restart the OpenClaw gateway** so the skill is loaded.

## Backend

The Agent OS backend must be running and expose `/api/tools/summarize-url` (Phase 1). See `backend/.env.example` for `TOOLS_SUMMARIZE_*` and `TOOLS_API_KEY`.
