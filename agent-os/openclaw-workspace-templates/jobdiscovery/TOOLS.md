# TOOLS — Job Discovery

## CEO identity (always pass in tool calls)

The logged-in CEO user id is sent in chat as `[ceo_user_id: …]` or in tool body as `"ceo_user_id"`. **Always include `ceo_user_id`** in every profile tool call.

## Profile management

- **job_search_profile_list** — List all profiles for this CEO. Body: `{ "ceo_user_id" }`.
- **job_search_profile_create** — New profile. Body: `{ "ceo_user_id", "profile_id", "display_name", "patch" }`.
- **job_search_profile_set_active** — Switch pipeline profile. Body: `{ "ceo_user_id", "profile_id" }`.
- **job_search_profile_get** — Read one profile (active if profile_id omitted).
- **job_search_profile_save** — Patch intake fields. Include **`workflow_goal`**: `"job_application"` | `"scoring_summary"`.
- **job_search_profile_intake_status** — Missing fields for a profile.
- **job_search_profile_confirm** — Activate profile + start pipeline. Body: `{ "ceo_user_id", "profile_id", "confirm": true }`.
- **job_search_profile_deactivate** — Pause profile (stops scheduled workflow). Body: `{ "ceo_user_id", "profile_id" }`.
- **job_search_profile_rename** — Change display name and/or profile_id slug. Body: `{ "ceo_user_id", "profile_id", "display_name", "new_profile_id" }` (at least one rename field).
- **job_search_profile_delete** — Permanently delete profile and its jobs. Body: `{ "ceo_user_id", "profile_id", "confirm": true }`. Always require explicit confirm from CEO before calling.
- **job_check_profile_active** — Gate before discovery.

When CEO asks to **list profiles**, call **job_search_profile_list** and present a readable table (id, display_name, status, is_active, target titles).

When CEO asks to **create** a search (e.g. "new profile for VP roles"), call **job_search_profile_create** then run intake for that profile_id.

When CEO asks to **switch** profile, call **job_search_profile_set_active**.

## Job tracker

- **job_portal_harvest_listings** — **Call first** for discovery. Backend scrolls + paginates LinkedIn/JobStreet search pages (OpenClaw Playwright) and returns `{ listings: [{ url, title, source }], new_listings }`. Body: `{ "ceo_user_id", "profile_id", "source"?: "linkedin"|"jobstreet" }`. Then open each **new** detail URL in browser and `jobs_append`.
- **job_inventory_summary** — Counts by status + URLs to skip. Call **before** every discovery run.
- **job_check_url_seen** — `{ "url", "company", "title" }` or batch `{ "jobs": [...] }`. Returns `block_rediscovery` if applied/skipped/in pipeline (cross-profile by default).
- **jobs_append** — `{ "ceo_user_id", "profile_id", "jobs": [...] }` — **each job must include** `title`, `company`, `location`, `url`, `source`, and `job_description` (from browser detail page). Auto-skips seen jobs.
- **jobs_list** — `{ "ceo_user_id", "profile_id", "status" }` — e.g. `applied`, `skipped`, `awaiting_approval`.

## Workflow (required for Kanban)

- **job_run_workflow_now** — **Call after every discovery run in chat.** Scores `discovered` jobs → tailors shortlisted → creates ONE Kanban CEO review task. Body: `{ "ceo_user_id", "profile_id" }`.
- **job_phase1_submit_ceo_review** — Same end result if jobs already scored/shortlisted.
- **job_pipeline_start** — Async multi-agent pipeline (separate Kanban cards per agent); use for scheduled runs, not typical chat discovery.
- **job_ceo_review_confirm** — CEO approved in Kanban; Application Agent runs next.
- **job_ceo_review_include** — CEO includes borderline jobs: `{ "job_ids": ["..."] }` → tailor → awaiting_approval.

## Other

- **browser** — required for LinkedIn/JobStreet discovery (scroll, paginate, open detail pages)
- **kanban_move_status**
- **summarize_url** — do NOT use for job discovery on LinkedIn/JobStreet (use browser only); Fit Scorer may use it later

---

## Browser discovery — scroll and paginate (required)

Use **browser** with `profile=openclaw` only. Never stop after the first snapshot (~4 visible cards).

### Two-phase workflow

**Phase A — Automated harvest (required first)**
1. **job_portal_harvest_listings** — scroll + paginate search results; returns many job URLs
2. `job_check_url_seen` on `new_listings`
3. Optional: run again with `"source": "jobstreet"` if profile has both portals

**Phase B — Enrich and append (browser detail pages)**
1. For each new listing URL: browser open detail → snapshot
2. Extract title, company, location, url, source, job_description (harvest `title` is a fallback)
3. `jobs_append` in batches of 5

Manual scroll on listing pages is a fallback only if harvest returns zero URLs.

### Profile quotas (read via job_search_profile_get)

- `discovery_min_per_source` (default 10)
- `discovery_max_per_run` (default 25)
- `discovery_depth.linkedin_pages` / `discovery_depth.jobstreet_pages` (default 3 each)

Do one portal at a time (LinkedIn, then JobStreet). Report pages scrolled and pagination clicks in your summary.

---

## Intake field keys (for patch)

`locations`, `work_mode`, `work_authorization`, `target_titles`, `seniority`, `industries`, `excluded_industries`, `priority_companies`, `blacklist_companies`, `discovery_rate`, `apply_rate_cap`, `sources`, **`portal_search_patterns`** (per-portal job search URL templates), `accounts`, `browser_session_ok`, `recruiter_outreach`, `master_resume_path`, `resume_formats`, `fit_threshold`, `borderline_review`, `qa_bank`, `no_auto_fill_fields`, `approval_channel`, `apply_platforms`, `ambiguous_form_policy`, `cover_letter_policy`, `google_sheet_id`, `gdrive_root_folder`, `gdrive_layout`, `discovery_schedule`, `notification_preferences`, `submit_policy`, `tailoring_rules`, `honesty_ack`

### Portal search URL patterns (`portal_search_patterns`)

Bind each portal to a URL template using profile fields. Saved on profile create/edit; discovery uses these instead of hard-coded URLs.

Placeholders: `{q}` `{loc}` `{title}` `{location}` `{title_slug}` `{location_slug}`

Example patch:

```json
{
  "portal_search_patterns": {
    "linkedin.com": "https://www.linkedin.com/jobs/search/?keywords={q}&location={loc}",
    "jobstreet.com.sg": "https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}"
  }
}
```

With `target_titles: ["SVP Head of Tech"]` and `locations: ["Singapore"]`, JobStreet resolves to:
`https://sg.jobstreet.com/SVP-head-of-tech-jobs/in-Singapore`

During intake, confirm patterns with the CEO when setting `sources`, `target_titles`, and `locations`.
