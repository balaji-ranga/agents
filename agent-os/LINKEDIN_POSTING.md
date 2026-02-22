# How Agent 2 (TechResearcher) Can Post to LinkedIn

## Current design: **semi-autonomous** (browser + human post)

TechResearcher does **not** post to LinkedIn itself. The flow is:

1. Propose **3 LinkedIn post topics** per cycle: **2 on AI, 1 on robotics** (deferred topics from the last week can be re-offered).
2. In the **daily standup**, CEO approves one topic; TechResearcher prepares the approved draft.
3. TechResearcher **opens the browser** with LinkedIn (feed/compose) and the approved draft.
4. **CEO (human) manually posts** on LinkedIn. The agent never clicks “Post”.
5. The **2 unchosen topics** are deferred and kept in **memory for at least 1 week** so the agent can recall and offer them again.

So: approval in standup → agent opens browser with LinkedIn → human posts. Deferred topics retained ≥1 week.

---

## If you want **autonomous** posting

To let Agent 2 post to LinkedIn **without** human approval each time, you would need to:

1. **Change SOUL.md and AGENTS.md** in `workspace-techresearcher` so that:
   - The rule “Seek approval via COO before posting” is removed or relaxed (e.g. “Post approved content only” or “Post drafts that match content policy without waiting for CEO approval”).
   - Guardrails in AGENTS.md that say “No direct LinkedIn posting without approval” are updated to allow posting when certain conditions are met (e.g. after a policy check, or on a schedule).

2. **Accept the risk**: Posts would go live without a human check. You’d rely on SOUL/AGENTS (and any content filters) to keep posts safe.

3. **Implement the actual post step** (see below), which is required for both approved and autonomous flows.

---

## How the “post” step works technically

Whether posting happens **after approval** or **autonomously**, something has to call LinkedIn. Options:

### Option A — LinkedIn API (recommended for automation)

- **LinkedIn Share API (UGC)** lets you create posts as the authenticated user (text, optional link/image).
- **Flow**: Your backend (or an OpenClaw skill) holds OAuth tokens for LinkedIn; when the agent has an approved (or policy-approved) post, your code calls LinkedIn’s API to create the post.
- **Requirements**: LinkedIn Developer app, OAuth 2.0 (e.g. `w_member_social` scope), token storage, and a small “post creator” service or skill that the agent can trigger with the final text (and optional media).

Agent OS could add an “approval” flow: TechResearcher submits a draft → CEO approves in the UI → backend calls LinkedIn API with that draft. For **autonomous** posting, the same backend endpoint could be called by the agent when SOUL/AGENTS allow it (e.g. after an internal policy check, no human in the loop).

### Option B — OpenClaw / ClawHub skill for LinkedIn

- If a **LinkedIn skill** exists in the OpenClaw ecosystem (bundled or ClawHub/UseClawPro verified), it would typically wrap the LinkedIn API.
- You’d install it in TechResearcher’s workspace (`workspace-techresearcher/skills/`), configure LinkedIn OAuth/credentials as required by the skill, and the agent would use that skill to post.
- **Security**: Use only skills from a trusted source (bundled or verified); vet any ClawHub skill before use (see `AGENT_REVIEW_AND_SKILLS.md`).

### Option C — Browser tool (open LinkedIn and post via UI)

**Yes, the agent can use a browser automation tool** (e.g. Playwright, Puppeteer, or an OpenClaw/ClawHub “browser” or “web automation” skill) to open LinkedIn in a browser, log in, and submit a post through the normal UI.

**How it would work:**

- You give the agent (or a skill it uses) access to a browser automation API: navigate to `https://www.linkedin.com/feed/`, fill the “Start a post” box with the draft text, click “Post”.
- Session: the browser session would need to be already logged in (e.g. persistent profile/cookies) or the automation would need to handle login (and possibly 2FA).

**Important caveats:**

| Issue | Detail |
|-------|--------|
| **LinkedIn Terms of Service** | LinkedIn’s ToS generally restrict automated scraping and automated posting. Using a browser bot to post can be treated as automation and may violate their policies; accounts can be restricted or banned. The **official LinkedIn API** is the supported way to post programmatically. |
| **Login & 2FA** | Automated login is brittle (captcha, 2FA, “suspicious activity”). You may need to keep a logged-in browser profile and reuse it, which has security and maintenance tradeoffs. |
| **UI fragility** | Any change to LinkedIn’s layout or class names can break the automation. You’d need to maintain selectors and flows. |
| **Skills** | If you use an OpenClaw/ClawHub “browser” or “playwright” skill, vet it (see `AGENT_REVIEW_AND_SKILLS.md`). Ensure it’s from a trusted source and doesn’t exfiltrate data. |

**Bottom line:** Technically yes — a browser tool can open LinkedIn and post. For production and ToS compliance, **LinkedIn’s API (Option A) is the right approach**. Use the browser approach only for personal experiments and with awareness of the risks above.

### Option D — Semi-automated (no API, no bot)

- Agent drafts the post; your app shows it and e.g. “Copy to clipboard” or “Open LinkedIn compose” (e.g. `https://www.linkedin.com/feed/` with pre-filled text if LinkedIn supports it, or a bookmarklet).
- A human (or a separate automation) actually clicks “Post” on LinkedIn. This is **not** autonomous from LinkedIn’s perspective but reduces manual writing.

---

## Summary

| Question | Answer |
|----------|--------|
| Can Agent 2 post to LinkedIn **autonomously** today? | **No.** SOUL/AGENTS require CEO approval via COO before any post. |
| How to **allow** autonomous posting? | Update TechResearcher’s SOUL.md and AGENTS.md to remove or relax the “approval before post” rule and define when the agent may post (e.g. content policy only, or schedule). |
| How does the **actual post** happen? | Via **LinkedIn API** (recommended), a **LinkedIn skill**, a **browser tool** (Playwright/Puppeteer or OpenClaw browser skill — possible but fragile and ToS‑sensitive), or **semi-automated** (draft + human posts). |
| What’s not built yet in Agent OS? | Approval UI (submit draft → CEO approve/reject) and the integration that calls LinkedIn (or a skill) to publish the approved post. |

If you tell me whether you want to keep approval-gated posting or switch to autonomous (with which conditions), I can suggest exact SOUL/AGENTS edits and where in Agent OS to add the approval + LinkedIn publish flow.
