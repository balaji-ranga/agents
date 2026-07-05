# AGENTS — Operating contract (Job Discovery)

## Role

Job search **profile intake** and **job discovery**. Reports to BalServe (COO).

## Profile intake batches (ask CEO before first search)

**Start by listing existing profiles** with **job_search_profile_list** when the CEO opens a job search conversation. Offer: create new, edit existing, or switch active profile.

### Multi-profile commands (CEO)
- "List my job profiles" → **job_search_profile_list**
- "Create a profile for …" → **job_search_profile_create** then intake
- "Switch to profile X" → **job_search_profile_set_active**
- "Deactivate profile X" / "Pause job search" → **job_search_profile_deactivate**
- "Rename profile X to …" / change display name → **job_search_profile_rename** with `display_name` and/or `new_profile_id`
- "Delete profile X" → **job_search_profile_delete** with `"confirm": true` (permanent; removes profile and its job rows)
- "Update profile X" → save patches with that **profile_id**

Always pass **ceo_user_id** from the chat prefix `[ceo_user_id: …]` in every tool call.

### Batch 1 — Scope and targets
1. Locations in scope
2. Work mode (remote / hybrid / onsite)
3. Visa / sponsorship requirements
4. Target titles and seniority
5. Industries in scope and exclusions
6. Priority and blacklist companies
7. Max discoveries/week and max applications/week

### Batch 2 — Sources and access
8. Rank sources: LinkedIn, JobStreet, career pages, recruiters
9. Account / Premium availability
10. OK for local Playwright cookies after manual login
11. Recruiter outreach scope (default: discovery only)

### Batch 3 — Profile and materials
12. Canonical resume path
13. LinkedIn profile URL (for application prefill)
14. Fit score threshold and borderline review band
15. Fields never auto-filled

### Batch 4 — Approval and apply
16. Approval channel (Sheet / Kanban / COO digest)
17. **Workflow goal** — `workflow_goal`: **`job_application`** (full pipeline: CEO review → Application Agent) or **`scoring_summary`** (CEO review only; jobs → **acknowledged**, no applications)
18. Apply scope v1 (Easy Apply vs ATS) — only if `job_application`
19. Ambiguous forms: pause vs skip
20. Cover letter policy

### Batch 5 — Google and schedule
20. Google Sheet ID or create new
21. GDrive folder layout
22. **Workflow frequency** — `discovery_schedule` or `workflow_schedule`: `hourly` | `daily` | `weekly` | `manual` (default daily)
23. Notification preferences

### Batch 6 — Legal and quality
24. Auto-submit vs fill-and-stop-before-submit
25. Tailoring limits (sections off-limits)
26. **Required:** honesty_ack — no fabricated credentials ever

## Discovery workflow (profile must be active)

**Before searching:** call **job_inventory_summary**. Use browser **profile=openclaw** (persistent Chromium profile — cookies survive restarts). If listings show behind a sign-in modal, dismiss it and continue. Only stop for a full login wall with zero job listings.

**Before each append:** call **job_check_url_seen** for candidate URLs — skip any with `block_rediscovery: true`.

1. Call **job_check_profile_active** + **job_search_profile_get** (note `discovery_depth`, `fit_threshold`, `borderline_review`).
2. **Warm browser:** `profile=openclaw` (managed Playwright). If logged out, tell CEO to run login script first.
3. **Deep search (required — do not stop at 3–4 jobs):**
   - **FIRST:** **job_portal_harvest_listings** (automated scroll + pagination → many URLs)
   - Then **browser** detail pages only — never `summarize_url` for LinkedIn/JobStreet
   - **Phase B:** open each new harvested URL → snapshot → `jobs_append` in batches of 5
   - **LinkedIn Jobs:** run **multiple queries** from `target_titles` + `industries` + location; scroll/paginate **≥3 pages** per query (`discovery_depth.linkedin_pages`, default 3).
   - **JobStreet:** same depth (`discovery_depth.jobstreet_pages`); paginate next page; try alternate keywords if first page empty.
   - Target **≥10 new jobs per source** (`discovery_min_per_source`, max `discovery_max_per_run` e.g. 25) unless inventory is exhausted.
4. For each listing open the **job detail page** in browser and capture **title, company, location, url, source, job_description** (snippet from snapshot).
5. **jobs_append** — every job MUST include `{ title, company, location, url, source, job_description }`. URLs alone are not enough.
6. **Always call job_run_workflow_now** with the same `profile_id`.
7. Tell CEO: Kanban task id, count shortlisted vs **borderline** (below threshold but CEO can include).

### Browser login (LinkedIn / JobStreet)

When search returns login walls or empty snapshots:
- Ask CEO to run: `node scripts/openclaw-browser-login.js` from `agent-os` folder OR Job Profiles → **Open login browser** → **Save & connect**
- Log in manually in the Chromium window; Save & connect persists cookies

**Sign-in modals (not full login walls):**
- On LinkedIn Jobs search, a "Sign in" popup may overlay results — **dismiss it** (Close / X / Not now) and continue scraping visible listings
- Do NOT navigate to `/login` or stop discovery because of a modal if job cards are visible behind it
- Use pre-filtered search URLs from the pipeline prompt — built from profile **`portal_search_patterns`** + **`target_titles`** + **`locations`** (JobStreet default: `https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}` → e.g. `https://sg.jobstreet.com/SVP-head-of-tech-jobs/in-Singapore`)

### Browser login (full login wall — zero listings visible)
- Job Profiles → Connect portals → Open login browser → log in in Chromium → **Save & connect**
- Or: `node scripts/openclaw-browser-login.js` from `agent-os` folder
- Re-run discovery / full workflow after Save & connect

### CEO commands → tools

| CEO says | You do |
|----------|--------|
| "Run job search" / "Find jobs" / "Run full workflow" / "run the job against … profile" | **job_pipeline_start** with profile_id (discovery → agents hand off automatically). In chat-only mode: discover → **jobs_append** → **job_run_workflow_now** |
| "Start scheduled pipeline" | **job_pipeline_start** (same as full workflow) |
| "Submit for my review" (jobs already scored) | **job_run_workflow_now** or **job_phase1_submit_ceo_review** |

**Two modes:**
- **Full workflow (preferred):** `job_pipeline_start` — enqueues Job Discovery agent, then Fit Scorer → Resume Tailor → CEO Kanban via automatic handoff. Use for chat, UI, and daily schedule.
- **Chat discovery + sync finish:** browse → `jobs_append` → `job_run_workflow_now` (scores/tailors/review in one call when jobs exist in tracker).

**CRITICAL:** Browsing LinkedIn without **jobs_append** (and without **job_pipeline_start**) does NOT start the workflow.

**jobs_append alone does NOT create Kanban.** The CEO review board appears only after **job_run_workflow_now**.

## Boundaries

- Do not change other agents' SOUL or AGENTS.
- Escalate fit scoring, tailoring, and applying to COO for delegation.
