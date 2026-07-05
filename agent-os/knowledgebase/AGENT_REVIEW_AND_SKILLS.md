# Agent Review & Secure Skill Recommendations

## 1. Agents created (review)

### BalServe (COO)

| Item | Summary |
|------|--------|
| **Workspace** | `C:\Users\balaj\.openclaw\workspace-balserve` |
| **Role** | COO — coordinates standups, CEO digest, approval flow |
| **SOUL** | Calm, formal, supportive; always available; delegates to other agents; escalates blockers; no downloads/posts without CEO approval; daily standups and summaries; collects approval requests and seeks CEO approval daily |
| **AGENTS** | Run standups, aggregate updates, CEO digest; escalate blockers; collect approval requests, CEO approval, forward to agents. Guardrails: never change other agents' SOUL/AGENTS; only use provided standup data; only summarize and report; never execute tasks for other agents |

### TechResearcher

| Item | Summary |
|------|--------|
| **Workspace** | `C:\Users\balaj\.openclaw\workspace-techresearcher` |
| **Role** | Research (AI and Tech); reports to BalServe |
| **SOUL** | Professional techie voice; no harmful content; seek approval via COO before any LinkedIn post; daily standup with COO; one LinkedIn post per day when approved |
| **AGENTS** | Deep research on AI and new tech; daily standup with COO; draft one LinkedIn post/day, submit to COO, CEO approval, post only after COO confirms. Guardrails: avoid harmful content; no direct LinkedIn posting without approval; max one post per day |

### SocialAssistant

| Item | Summary |
|------|--------|
| **Workspace** | `C:\Users\balaj\.openclaw\workspace-socialasstant` |
| **Role** | Facebook content (travel, places, nature, cuisines); useful, appealing, brand-consistent; reports to BalServe |
| **SOUL** | Funny, creative, disciplined, well mannered; no sexual/political/harmful content; no publish without COO/CEO approval |
| **AGENTS** | Create Facebook drafts (text, image/video concepts); keep brand consistent; draft, approve, publish only after approval. Guardrails: no publish without approval; do not change other agents' SOUL/AGENTS |
| **TOOLS** | See workspace TOOLS.md: Facebook draft/publish tools; content generation; image generation; video generation; online links. All generation is draft-only until approved. |

---

## 2. What counts as secure for skills

| Source | Security level | Notes |
|--------|----------------|--------|
| **OpenClaw bundled skills** | **Highest** | First-party, shipped with OpenClaw. Enable in config or workspace. |
| **UseClawPro Verified Catalog** | **High** | Audited/verified. Use when you want community skills with a trust layer. |
| **ClawHub (unvetted)** | **Risk** | Only use after vetting (author, code review, sandbox). |

Security practices: treat third-party skills as untrusted; vet before install; prefer sandbox; use Skill Verifier when available.

---

## 3. Skill recommendations (for your approval)

- **BalServe** — skills in `workspace-balserve/skills/` or shared via `~/.openclaw/skills`.
- **TechResearcher** — skills in `workspace-techresearcher/skills/` or shared.

Option A: Bundled/first-party only (safest). Option B: UseClawPro Verified. Option C: ClawHub after manual vetting.

---

## 4. Conform before adding

No skills will be added until you explicitly confirm. Reply with: "No extra skills", "Add only: [list]", or "I'll use UseClawPro/ClawHub myself".

---

## 5. Where skills live

- **Per-agent:** `~/.openclaw/workspace-balserve/skills/`, `~/.openclaw/workspace-techresearcher/skills/`.
- **Shared (all agents):** `~/.openclaw/skills/`.
- Workspace wins on name conflict.
