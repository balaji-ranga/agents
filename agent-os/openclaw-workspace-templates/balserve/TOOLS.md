# TOOLS — Agent OS tools

When you have access to Agent OS tools, invoke them **by tool name with JSON parameters**; do not use exec or run as shell commands.

---

## Choosing the right tool

- **Match the tool to the request:** Read the user's message and choose the tool whose purpose best fits what they asked for (e.g. rates → forex_rates, web summary → summarize_url, image → generate_image, **run custom workflow** → agent_workflow_trigger). Use each tool's description to decide.
- **If a tool's result is not good enough:** If a tool returns an error, empty data, "not found," or a result that clearly doesn't answer the user's request, try the **next most relevant tool** from your list and respond using that. Do not give up after one failed or inadequate result—use another tool that fits the context when possible.

---

## Custom agent workflows (Workflows UI)

These tools let the CEO run published workflows from chat. They are **not** the legacy Job Applicant pipeline (`job_run_workflow_now`).

| Tool | When to use |
|------|-------------|
| **agent_workflow_enquire** | CEO describes a workflow loosely ("the MCP test one", "brain approval"). Pass `query` with their description, or `all: true` to return every published workflow. Returns `id`, `trigger_modes`, `chat_trigger_phrase`, and `trigger_hint`. |
| **agent_workflow_list** | List **all** published workflows (manual, schedule, webhook, and chat). Pass `chat_only: true` to limit to chat-phrase triggers only. |
| **agent_workflow_trigger** | Start a run. Pass `message` with the exact chat phrase (e.g. `testMCP`, `run brain approval test`) **or** `workflow_id` for any published workflow. Optional `input` for run payload. |

**Typical flow:** If the CEO asks to run something by description → **agent_workflow_enquire** first → then **agent_workflow_trigger** with the returned phrase or id. If you already know the phrase, call **agent_workflow_trigger** directly.

Do **not** use exec, shell, or `job_run_workflow_now` for custom agent workflows.

---

## Browser automation (OpenClaw + Playwright)

You have the **browser** tool for web automation (navigate, snapshot, click, type, screenshot).

- **Always use `profile="openclaw"`** — the managed Playwright/Chromium browser. Do **not** use `profile="chrome"` unless the user explicitly asks to attach their Chrome tab via the Browser Relay extension.
- Typical flow: `browser` action start (profile openclaw) → open URL → snapshot → act using refs from snapshot.
- If browser fails, report the error; do not ask the user to install the Chrome extension unless they requested chrome profile.
