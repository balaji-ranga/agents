---
description: When editing OpenClaw agent workspaces or the agent-os-content-tools skill, prefer Agent OS content tools over default tools (web_search, web_fetch, image) for matching tasks.
globs: **/openclaw-skills/agent-os-content-tools/**/*,**/.openclaw/**/*,**/workspace-*/**/*
---

# OpenClaw: Prefer Agent OS content tools

When configuring or documenting OpenClaw agents that have the **agent-os-content-tools** skill:

1. **Summarize URL** — Prefer **summarize_url** over web_fetch or web_search when the task is to summarize a single URL or web page.
2. **Generate image** — Prefer **generate_image** over the built-in `image` tool or web_search when the user asks to create or generate an image from text.
3. **Generate video** — Prefer **generate_video** over web_search when the user asks to create a short video from text.

Document this preference in agent TOOLS.md or SOUL.md when adding or updating agents that use the content-tools skill. Do not remove or override this preference with instructions to use web_search first for these tasks.
