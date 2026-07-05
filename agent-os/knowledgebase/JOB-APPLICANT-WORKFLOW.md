# Job Applicant Agentic Workflow

**Goal:** Automated job search pipeline orchestrated by OpenClaw (BalServe COO) with four specialist agents, Google Sheets for tracking, Google Drive for resume variants, Playwright for form filling, and LLM for fit scoring and tailoring.

**Isolation:** Job Applicant agents and tools are installed via `node scripts/setup-job-applicant-agents.js`. Existing agents (BalServe, TechResearcher, ExpenseManager, SocialAssistant) are not modified except that BalServe's live `AGENTS.md` gains four new table rows for delegation.

---

## Architecture

```
CEO (you) → BalServe COO → Job Discovery → Fit Scoring → Resume Tailoring → [approval] → Application Agent
                ↓              ↓                ↓                  ↓                              ↓
            Kanban         Google Sheets    LLM + profile      GDrive + LLM              Playwright
```

**Source of truth:** Google Sheets (production). Phase 1 uses Agent OS SQLite `job_applications` table until Google OAuth is configured.

**Profile gate:** No discovery, scoring, tailoring, or applying until `job_search_profile.status = active`.

---

## Agents

| Agent ID | Name | Purpose |
|----------|------|---------|
| `jobdiscovery` | Job Discovery | **Profile intake interview**, job search, append jobs to tracker |
| `fitscorer` | Fit Scoring | Compare jobs to profile; score and shortlist/skip |
| `resumetailor` | Resume Tailoring | Honest resume variants, cover letter, why-me, Q&A mapping |
| `applicationagent` | Application Agent | Fill forms and upload resume **only after CEO approval** |

All report to BalServe (`parent_id: balserve`).

---

## Profile intake (Job Discovery agent)

Before any search, Job Discovery runs a structured intake in six batches. Answers are saved via **`job_search_profile_save`**; status via **`job_search_profile_intake_status`**.

### Batch 1 — Scope and targets
1. Locations in scope (cities, countries, anywhere)
2. Work mode: remote / hybrid / onsite — hard rules
3. Visa or sponsorship requirements
4. Target job titles and seniority band
5. Industries/domains in scope and exclusions
6. Companies to prioritize or blacklist
7. Target volume: max discoveries/week, max applications/week

### Batch 2 — Sources and access
8. Rank job sources: LinkedIn, JobStreet, career pages, recruiters
9. Account availability (Premium, etc.)
10. OK to use local Playwright session cookies after manual login (no passwords in config)
11. Recruiter outreach: discovery only vs draft outreach (default: discovery only)

### Batch 3 — Profile and materials
12. Canonical resume path (e.g. `1_foundations/me/Bala_resume_latest.pdf`)
13. Fit score threshold for auto-shortlist; borderline review band
14. Q&A bank: salary, notice period, relocation, work auth
15. Fields that must **never** be auto-filled

### Batch 4 — Approval and apply behavior
16. Approval channel: Sheet column, Kanban, or COO digest
17. Apply scope v1: Easy Apply only vs ATS (Workday, Greenhouse)
18. Ambiguous forms: pause and ask CEO vs skip job
19. Cover letter policy: full letter / why-me only / when required

### Batch 5 — Google and orchestration
20. Google Sheet ID or create new
21. GDrive folder layout (default: `/JobApplications/{company}/{job_id}/`)
22. Discovery schedule: daily / weekly / manual
23. Notification preferences when approval needed

### Batch 6 — Legal and quality bar
24. After approval: auto-submit vs fill-and-stop-before-submit
25. Tailoring limits: reorder/emphasize OK; sections off-limits
26. **Required:** Confirm no fabricated employers, skills, degrees, or dates

After intake, Discovery produces a summary and calls **`job_search_profile_confirm`** only after CEO says "confirm". That sets `status=active` and **starts the automated pipeline** (first discovery run).

---

## Automated pipeline (after profile active)

**Interactive:** Only profile intake with Job Discovery + CEO.

**Automated:** Discovery → Fit Scoring → Resume Tailoring → *(CEO approval on Kanban)* → Application Agent.

Each stage:
1. Creates a **Kanban task** (`created_by: job_pipeline`) assigned to the agent
2. Creates a **delegation task** processed by the backend cron (same as COO delegation)
3. On completion → **notification bell** + optional Chat link
4. On completion → **automatic handoff** to the next stage (except after tailoring — CEO must approve)

### Handoff chain

```
profile confirm → discovery → fitscorer → resumetailor → [awaiting_confirmation Kanban]
                                                              ↓ CEO approves job(s)
                                                         applicationagent
```

### Schedule

- **On confirm:** Immediate discovery run
- **Cron:** `JOB_PIPELINE_CRON_SCHEDULE` (default `0 */6 * * *` — every 6 hours) runs discovery if due per profile `discovery_schedule` (daily / weekly / manual)
- **Applications:** Enqueued when job status becomes `approved` (via `jobs_update`)

### API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/job-applicant/pipeline/status` | Enabled flag, pending stages, job counts |
| `POST /api/job-applicant/pipeline/start` | Enable + start discovery |
| `POST /api/job-applicant/pipeline/stop` | Pause scheduled pipeline |
| `POST /api/job-applicant/pipeline/tick` | Manual cron tick |

### CEO approval

- Resume Tailoring sets jobs to `awaiting_approval` and Kanban to **awaiting_confirmation**
- Approve via Kanban UI or `jobs_update` with `{ "status": "approved" }` or `{ "owner_action": "approve" }`
- Application Agent runs automatically when approved jobs exist

### Application inventory (do not re-suggest)

- All jobs live in SQLite `job_applications` (+ CSV export per profile).
- **Before discovery:** Job Discovery calls `job_inventory_summary` or `jobs_list` (`applied`, `skipped`).
- **Before append:** `job_check_url_seen` — blocks if same URL (normalized) exists on **any profile** for this CEO with status applied/skipped/in-pipeline.
- **`jobs_append`** auto-skips seen jobs; response includes `skipped_seen` with reasons.
- **`scoring_summary` profile:** CEO confirm → jobs **`acknowledged`** → workflow ends (no Application Agent)
- **`job_application` profile:** CEO confirm → **`approved`** → prefill → Application Agent

---

## Multi-profile (per CEO user)

Each logged-in CEO can have **multiple named profiles** (e.g. `fintech-architect`, `banking-vp`). One profile is **active** for the pipeline at a time.

| Concept | Detail |
|---------|--------|
| **ceo_user_id** | From dashboard chat `user_id` (localStorage `agent-os-ceo-user-id`, default `default`) or env `AGENT_OS_CEO_USER_ID` |
| **profile_id** | Short slug per search campaign |
| **active profile** | Stored in `job_search_ceo_settings`; confirm sets active |

### Tools (Job Discovery)

| Tool | Purpose |
|------|---------|
| `job_search_profile_list` | List all profiles for CEO |
| `job_search_profile_create` | Create new profile |
| `job_search_profile_set_active` | Switch pipeline to another profile |
| `job_search_profile_get/save/confirm` | Optional `ceo_user_id` + `profile_id` on all calls |

### API

- `GET /api/job-applicant/profiles?ceo_user_id=default` — list profiles

Chat with Job Discovery: *"List my job profiles"*, *"Create a profile for VP banking roles"*, *"Switch to fintech-architect"*.

---

## Application tracker schema

| Column | Purpose |
|--------|---------|
| `job_id` | Stable hash (URL + company + title) |
| `status` | discovered → scored → shortlisted → resume_ready → awaiting_approval → approved → applied / skipped / failed |
| `source` | linkedin / jobstreet / career_page / recruiter |
| `company`, `title`, `location`, `url` | Job metadata |
| `fit_score`, `fit_rationale` | Fit Scoring output |
| `resume_variant_path`, `cover_letter_path` | GDrive paths (Phase 2+) |
| `why_me_summary` | Tailored blurb for forms |
| `owner_action` | approve / skip / defer (CEO) |

---

## Tools (Agent OS backend)

Registered by `setup-job-applicant-agents.js` into `content_tools_meta` with per-agent overrides.

| Tool | Agents | Purpose |
|------|--------|---------|
| `job_search_profile_get` | all job agents | Read profile + intake status |
| `job_search_profile_save` | jobdiscovery | Save intake answers (partial OK) |
| `job_search_profile_intake_status` | jobdiscovery | List missing required fields |
| `job_search_profile_confirm` | jobdiscovery | CEO confirmed → status active |
| `job_check_profile_active` | jobdiscovery, fitscorer, resumetailor, applicationagent | Gate: error if not active |
| `jobs_list` | all job agents | Filter by status |
| `job_check_url_seen` | jobdiscovery | Check URL/company/title against inventory before append |
| `job_inventory_summary` | jobdiscovery | Status counts + URLs to skip before discovery |
| `jobs_append` | jobdiscovery | Add jobs; auto-skips applied/skipped/in-pipeline (cross-profile URL) |
| `jobs_update` | fitscorer, resumetailor, applicationagent | Patch job row |
| `job_fit_score` | fitscorer | LLM score vs profile |

**Phase 2+ (not yet implemented):** `gdrive_upload_file`, `gdrive_download_file`, `tailor_resume`, `generate_cover_letter`, Google Sheets sync.

---

## COO delegation triggers

| CEO / user message | Delegate to |
|--------------------|-------------|
| "Set up my job search profile" | jobdiscovery (intake) |
| "Run job discovery" | jobdiscovery (requires active profile) |
| "Score new jobs" | fitscorer |
| "Prepare applications for shortlisted" | resumetailor |
| "Apply to approved jobs" | applicationagent |

BalServe uses `intent_classify_and_delegate` or `sessions_send` to `agent::jobdiscovery:main`, etc.

---

## Setup and run

### One-time setup

```powershell
cd agent-os
node scripts/setup-job-applicant-agents.js
# Restart backend and OpenClaw gateway
```

This creates four workspaces under `~/.openclaw/workspace-jobdiscovery`, etc., registers agents in DB, merges into `openclaw.json`, seeds tools, and appends rows to BalServe `AGENTS.md`.

### Start intake

Chat with **Job Discovery** in Agent OS or tell BalServe: *"Set up my job search profile"*.

### Environment (optional, Phase 2+)

```env
# Google Sheets / Drive (future)
# GOOGLE_SERVICE_ACCOUNT_JSON_PATH=
# JOB_APPLICANT_SHEET_ID=
# JOB_APPLICANT_GDRIVE_ROOT_FOLDER_ID=
```

---

## Phased implementation status

| Phase | Scope | Status |
|-------|--------|--------|
| 0 | Profile intake, agents, local job store, fit scoring | **In progress** |
| 1 | Google Sheets read/write | Planned |
| 2 | GDrive + resume tailoring LLM | Planned |
| 3 | Browser discovery (LinkedIn, JobStreet) | Planned |
| 4 | Application automation (Easy Apply first) | Planned |

---

## Guardrails

- **No fabrication:** Resume Tailoring must only rephrase/emphasize existing facts.
- **No apply without approval:** Application Agent requires `status=approved` or `owner_action=approve`.
- **Profile gate:** Discovery agent must not scrape until profile is active.
- **Credentials:** Browser cookies in local Playwright profile only; never store passwords in agent config.

---

## Related docs

- **TESTING.md** — restart backend/gateway after setup
- **AGENT_REVIEW_AND_SKILLS.md** — agent security patterns
- **onboard-api-tool.js** — pattern for adding external API tools later (Google)
