# Agent Review & Secure Skill Recommendations

## 1. Agents created (review)

### BalServe (COO)

| Item | Summary |
|------|--------|
| **Workspace** | `C:\Users\balaj\.openclaw\workspace-balserve` |
| **Role** | COO — coordinates standups, CEO digest, approval flow |
| **SOUL** | Calm, formal, supportive; always available; delegates to other agents; escalates blockers; no downloads/posts without CEO approval; daily standups and summaries; collects approval requests and seeks CEO approval daily |
| **AGENTS** | Run standups → aggregate updates → CEO digest; escalate blockers; collect approval requests → CEO approval → forward to agents. Guardrails: never change other agents’ SOUL/AGENTS; only use provided standup data; only summarize and report; never execute tasks for other agents |

### TechResearcher

| Item | Summary |
|------|--------|
| **Workspace** | `C:\Users\balaj\.openclaw\workspace-techresearcher` |
| **Role** | Research (AI & Tech); reports to BalServe |
| **SOUL** | Professional techie voice; no harmful content (bias, sexuality); seek approval via COO before any LinkedIn post; daily standup with COO; one LinkedIn post per day when approved |
| **AGENTS** | Deep research on AI and new tech; daily standup with COO (summarize topics); draft one LinkedIn post/day → submit to COO → CEO approval → post only after COO confirms. Guardrails: avoid harmful content; no direct LinkedIn posting without approval; max one post per day |

---

## 2. What counts as “secure” for skills

| Source | Security level | Notes |
|--------|----------------|--------|
| **OpenClaw bundled skills** | **Highest** — first-party, shipped with OpenClaw | Maintained by OpenClaw; no install from the public internet. Enable in config or workspace. |
| **UseClawPro Verified Catalog** | **High** — audited/verified | Third-party audited for safety; use when you want community skills with a trust layer. |
| **ClawHub (unvetted)** | **Risk** — community, unvetted | 400+ malicious skills have been found. **Only use after vetting** (author, code review, `clawhub install` with inspect/sandbox). |

Security practices (from OpenClaw / Learn OpenClaw):

- Treat third-party skills as **untrusted**; read code before enabling.
- **Vet before install:** check author, stars/downloads, read code for `fetch`/`env`/`eval`/`exec`/`spawn`, recent activity.
- Prefer **sandbox** when installing: `openclaw skill install author/skill-name --sandbox` (where supported).
- Use **Skill Verifier** (e.g. UseClawPro) for trust scoring and permission analysis when available.

---

## 3. Skill recommendations (for your approval)

Skills are loaded per workspace. So:

- **BalServe** → skills in `workspace-balserve/skills/` (or shared via `~/.openclaw/skills`).
- **TechResearcher** → skills in `workspace-techresearcher/skills/` (or shared).

Below are **suggestions only**. Nothing will be added until you confirm.

### Option A — Bundled / first-party only (safest)

| Agent | Skill idea | Source | Why |
|-------|------------|--------|-----|
| **BalServe** | (None strictly required) | — | COO behavior is mostly prompt/AGENTS.md; optional: any bundled “summarize” or internal-comms style skill if OpenClaw ships one. |
| **TechResearcher** | General-purpose / research (if bundled) | OpenClaw bundled | Check `openclaw skill list` for what your install ships; add only if you want extra tools for research. |
| **TechResearcher** | Google/integration skills — optional | OpenClaw bundled | Gmail/Calendar/Drive if you want the agent to use Google for research. Only add if you’re comfortable with Google OAuth. |

**Recommendation:** Start with **no extra skills** for both, or add only a general-purpose bundled skill for TechResearcher if your OpenClaw install ships one (e.g. run `openclaw skill list` to see bundled skills). All other bundled skills (e.g. Sonos, Spotify, Discord) are not needed for COO or research unless you decide otherwise.

### Option B — Add from UseClawPro Verified Catalog (if you use it)

- Use **UseClawPro’s Verified Skills** list and pick only skills that:
  - Are marked verified/audited.
  - Match the role (e.g. summarization for COO, research/search for TechResearcher).
- Do **not** add any skill that can post to the internet or download files without going through your approval flow; your SOUL/AGENTS already enforce that at the agent level.

### Option C — ClawHub after manual vetting

- Only consider skills that you (or a trusted person) have **vetted** using:
  - [Learn OpenClaw – ClawHub Vetting](https://learnopenclaw.com/security/clawhub-vetting) (author, code, no suspicious `fetch`/`env`/`eval`/`exec`/`spawn`, recent activity).
- Install with sandbox if available: `clawhub install <slug>` and inspect permissions; use `--sandbox` if the CLI supports it.

---

## 4. Conform before adding

**No skills will be added to BalServe or TechResearcher until you explicitly confirm.**

Please reply with one of:

1. **“No extra skills”** — Keep both agents with only their SOUL/AGENTS/MEMORY (no new skills).
2. **“Add only: [list]”** — e.g. “Add only: agent-tools for TechResearcher” or “Add only: [skill name] for BalServe.” I will then add only those from bundled or from a source you approved.
3. **“I’ll use UseClawPro / ClawHub myself”** — I won’t add any skills; you’ll install and vet yourself and we’ll document where to put them (per-agent `workspace-xxx/skills/`).

If you choose to add skills, I will:

- Use **only** OpenClaw bundled skills or skills from a source you’ve approved (e.g. UseClawPro Verified).
- Add them to the **specific agent workspace** you approved (e.g. `workspace-techresearcher/skills/`).
- Not add any skill that contradicts your guardrails (e.g. no “post to LinkedIn” or “download from internet” without approval).

---

## 5. Where skills live (for reference)

- **Per-agent:** `C:\Users\balaj\.openclaw\workspace-balserve\skills\` and `C:\Users\balaj\.openclaw\workspace-techresearcher\skills\`.
- **Shared (all agents):** `C:\Users\balaj\.openclaw\skills\`.
- OpenClaw loads workspace skills from each agent’s workspace; shared skills from `~/.openclaw/skills`. Workspace wins on name conflict.
