# Brainstorm: Enabling OpenClaw Tools/Skills for Facebook, LinkedIn, YouTube Posting

This doc outlines options for adding **post to Facebook**, **post to LinkedIn**, and **post to YouTube** as OpenClaw tools (and a skill), so agents like SocialAssistant can draft and—with approval—publish.

## How it fits OpenClaw today

- **Tools**: Backend `content_tools_meta` defines tools; OpenClaw plugin reads `~/.openclaw/agent-os-tools.json` and calls `POST /api/tools/invoke` with `{ tool_name, ...params }`. Backend routes `invoke` to the tool’s `endpoint` (e.g. `/api/tools/summarize-url`).
- **Skill**: A skill (e.g. `agent-os-content-tools`) tells the agent *when* to use each tool and how to call the backend. Same pattern can be used for social posting.
- **Approval**: Existing guardrails (COO/CEO approval before publishing) stay; new tools can return “draft ready” or “scheduled” and only post after an explicit approve step.

---

## Option 1: Official platform APIs

**What**: Use each platform’s official API (Facebook Graph, LinkedIn API, YouTube Data API).

| Platform   | API / product        | Notes |
|-----------|----------------------|--------|
| Facebook  | Graph API + Marketing API | Page/Group posting; app review for some permissions. |
| LinkedIn  | Share API (UGC)      | 60-day tokens; refresh often limited to approved partners. |
| YouTube   | Data API v3         | OAuth with `access_type=offline`; uploads via resumable upload. |

**Pros**

- ToS-compliant, stable, and supported.
- No dependency on UI; works headless/server.
- Clear rate limits and error handling.

**Cons**

- OAuth per platform (different flows; token storage and refresh).
- Facebook/LinkedIn app review for certain scopes.
- Implementation and maintenance per platform (2–4 weeks each is a common estimate).

**OpenClaw integration**

- New backend routes: e.g. `POST /api/tools/post-facebook`, `post-linkedin`, `post-youtube` (or one `post-social` with `platform` param).
- Store OAuth tokens per user/agent in DB or vault; backend uses them when invoking the tool.
- Add tool definitions to `content_tools_meta` and a skill (e.g. extend `agent-os-content-tools` or add `agent-os-social-posting`) that says: “Use post_facebook / post_linkedin / post_youtube only after approval; pass message, optional media URL, etc.”

---

## Option 2: Headless browser / browser automation

**What**: Automate the real web UI (log in, open composer, paste text, attach media, click Post) using a browser controlled by code.

**Stack options**

| Tool        | Type              | Notes |
|------------|-------------------|--------|
| **Camoufox** | Anti-detect Firefox | Stealth-focused; reduces automation fingerprinting. Python, ~200MB. Active again (2026). Good when platforms are strict on bots. |
| **Playwright** | Chromium/Firefox/WebKit | Robust, well-documented. No built-in anti-detect; sites may detect automation. |
| **Puppeteer** | Chromium           | Same idea as Playwright; JS-native. |
| **Selenium**  | Multi-browser      | Older; more flaky with modern SPAs. |

**Pros**

- No app review or OAuth per platform (you use the user’s existing session).
- Same flow as a human: works for any UI the user can use (including DMs, stories, etc. if you automate those).
- Can handle captchas or 2FA if a human intervenes or you integrate a solver (with policy/legal care).

**Cons**

- **ToS risk**: Many platforms prohibit automation; account risk.
- **Fragility**: UI changes break selectors; need maintenance.
- **Ops**: Need a browser runtime (local or in Docker), possibly display/VNC or headless. Camoufox is heavier (Python, larger image).
- **Security**: Session cookies/tokens in automation env must be locked down.

**OpenClaw integration**

- Backend service (Node or Python) that runs the browser (e.g. Playwright or Camoufox).
- New routes: e.g. `POST /api/tools/post-facebook-browser`, etc. Request body: `{ message, media_path_or_url?, session_label? }`. Backend queues or runs a job that launches the browser, injects cookies or logs in, performs the post, returns success/failure.
- Tool meta and skill same as above: one tool per platform or one `post_social_browser` with `platform`.
- Optional: “draft only” mode that fills the composer and stops before “Post” so a human can confirm in the same browser session.

---

## Option 3: Unified social / “one API” providers

**What**: Use a third-party that already integrates Facebook, LinkedIn, YouTube (and others) behind one API and handles OAuth and posting.

**Examples**: Ayrshare, Late, Postproxy, Buffer API, Hootsuite, etc.

**Pros**

- One OAuth and one integration; faster to ship.
- They handle platform changes and rate limits.
- Often include scheduling, analytics, and webhooks.

**Cons**

- Cost (subscription); dependency on their availability and roadmap.
- May not support every feature (e.g. every YouTube or LinkedIn option).
- Data and tokens live in their systems; review privacy/terms.

**OpenClaw integration**

- Backend route: e.g. `POST /api/tools/post-social` with `{ platform: 'facebook'|'linkedin'|'youtube', message, media_url?, ... }`. Backend maps to the provider’s API and stores their API key (or user-linked OAuth) in config/DB.
- Single tool in `content_tools_meta` (e.g. `post_social`) and skill text that lists supported platforms and “only after COO/CEO approval.”

---

## Option 4: Hybrid (API where possible, automation as fallback)

**What**: Prefer official APIs for posting where you have tokens and app approval; use browser automation only for platforms or accounts where API is not available (e.g. no app approval yet, or personal profiles with limited API support).

**OpenClaw integration**

- One logical tool per platform: `post_facebook`, `post_linkedin`, `post_youtube`. Backend tries API first; if disabled or failing, can optionally call an “automation worker” (e.g. Camoufox/Playwright) for that request, with feature flags and logging so you can audit and phase out automation over time.

---

## Recommendation (short)

- **Production / compliance first**: Prefer **Option 1 (official APIs)** or **Option 3 (unified API)** so posting is ToS-compliant and maintainable. Add one tool per platform (or one `post_social` with `platform`) and a single skill that mandates approval before any post.
- **Fast prototype or no app review**: Use **Option 2** with **Playwright** (simplest) or **Camoufox** (if you need anti-detect) in a separate worker; expose as tools that only run in “draft” or “staging” until you have approval and API path.
- **Long term**: Move to **Option 4** so everything is behind the same OpenClaw tool names, with API as primary and automation as opt-in fallback where necessary.

---

## Minimal implementation sketch (any option)

1. **Backend**
   - New route(s) in `backend/src/routes/tools.js` (or a dedicated `social.js`): e.g. `POST /api/tools/post-facebook`, `post-linkedin`, `post-youtube`. Each validates input, then either calls platform API, unified provider, or enqueues a browser-automation job.
   - Optional: store tokens/API keys in DB or env (e.g. `FACEBOOK_PAGE_ACCESS_TOKEN`, `LINKEDIN_ACCESS_TOKEN`, `YOUTUBE_OAUTH_*` or provider API key).

2. **Tool meta**
   - Seed or insert rows in `content_tools_meta`: `post_facebook`, `post_linkedin`, `post_youtube` (or `post_social`) with `endpoint` pointing at the new route(s). Run existing logic that writes `agent-os-tools.json` so the OpenClaw plugin picks them up.

3. **Skill**
   - New skill `agent-os-social-posting` (or extend `agent-os-content-tools`): describe when to use each tool (“post to Facebook only after COO/CEO approval”; “use post_linkedin for LinkedIn”; “use post_youtube for YouTube”), parameters (message, optional media URL, optional schedule), and that agents must never post without approval.

4. **Agent config**
   - In `apply-openclaw-agents-config.js` (or equivalent), allow the new skill/plugin for SocialAssistant (and any other agent that should be able to draft/post).

5. **Approval flow**
   - Keep current standup/COO approval; tool can return “Draft prepared; post id X pending approval.” A separate “approve post” action (or existing standup approve) then calls the same backend with “confirm post X” to actually publish.

---

## References

- **Camoufox**: [camoufox.com](https://camoufox.com) — anti-detect Firefox, headless automation; Python.
- **Playwright**: [playwright.dev](https://playwright.dev) — cross-browser automation; Node/Python.
- **APIs**: Facebook [Graph API](https://developers.facebook.com/docs/graph-api), [LinkedIn Share API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/share-api), [YouTube Data API v3](https://developers.google.com/youtube/v3).
- **Unified**: Ayrshare, Late, Postproxy (OAuth and posting abstractions).
