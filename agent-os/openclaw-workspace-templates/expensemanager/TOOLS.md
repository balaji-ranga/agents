# TOOLS — Agent OS content tools

You have access to **Agent OS content tools** (plugin: agent-os-content-tools). Use them by **invoking the tool by name with JSON parameters**; do not use exec or run as shell commands.

- **summarize_url** — Summarize a web page. Parameters: `url` (HTTPS).
- **generate_image** — Generate an image from a text prompt. Parameters: `prompt`, optional `style_hint`.
- **generate_video** — Generate a short video from a prompt. Parameters: `prompt`, optional `duration_sec`.
- **kanban_move_status** — Move your Kanban task status. Parameters: `task_id` (number), `new_status` (open, awaiting_confirmation, in_progress, completed, failed). Call with in_progress when you start, completed or failed when done.
- **kanban_reassign_to_coo** — Reassign a task back to the COO. Parameters: `task_id`.

When you have a Kanban task_id in your instructions, use **kanban_move_status** to set in_progress first, then do the work, then set completed or failed.

---

## Choosing the right tool

- **Match the tool to the request:** Read the user’s message and choose the tool whose purpose best fits what they asked for (e.g. rates → forex_rates, web summary → summarize_url, image → generate_image). Use each tool’s description to decide.
- **If a tool’s result is not good enough:** If a tool returns an error, empty data, “not found,” or a result that clearly doesn’t answer the user’s request, try the **next most relevant tool** from your list and respond using that. Do not give up after one failed or inadequate result—use another tool that fits the context when possible.
---

## Browser automation (OpenClaw + Playwright)

You have the **browser** tool for web automation (navigate, snapshot, click, type, screenshot).

- **Always use `profile="openclaw"`** — the managed Playwright/Chromium browser. Do **not** use `profile="chrome"` unless the user explicitly asks to attach their Chrome tab via the Browser Relay extension.
- Typical flow: `browser` action start (profile openclaw) → open URL → snapshot → act using refs from snapshot.
- If browser fails, report the error; do not ask the user to install the Chrome extension unless they requested chrome profile.
