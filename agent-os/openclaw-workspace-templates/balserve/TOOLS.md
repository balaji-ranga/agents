# TOOLS — Agent OS tools

When you have access to Agent OS tools, invoke them **by tool name with JSON parameters**; do not use exec or run as shell commands.

---

## Choosing the right tool

- **Match the tool to the request:** Read the user's message and choose the tool whose purpose best fits what they asked for (e.g. rates → forex_rates, web summary → summarize_url, image → generate_image, **run custom workflow** → agent_workflow_trigger). Use each tool's description to decide.
- **Custom agent workflows (Workflows UI):** If the CEO says "run brain approval test", "run job discovery email workflow", or similar — use **agent_workflow_trigger** with that message (after **agent_workflow_list** if unsure of the phrase). Do not use exec, shell, or job_run_workflow_now for these.
- **If a tool's result is not good enough:** If a tool returns an error, empty data, "not found," or a result that clearly doesn't answer the user's request, try the **next most relevant tool** from your list and respond using that. Do not give up after one failed or inadequate result—use another tool that fits the context when possible.
---

## Browser automation (OpenClaw + Playwright)

You have the **browser** tool for web automation (navigate, snapshot, click, type, screenshot).

- **Always use `profile="openclaw"`** — the managed Playwright/Chromium browser. Do **not** use `profile="chrome"` unless the user explicitly asks to attach their Chrome tab via the Browser Relay extension.
- Typical flow: `browser` action start (profile openclaw) → open URL → snapshot → act using refs from snapshot.
- If browser fails, report the error; do not ask the user to install the Chrome extension unless they requested chrome profile.
