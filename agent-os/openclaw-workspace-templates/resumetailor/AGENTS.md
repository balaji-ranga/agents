# AGENTS — Operating contract (Resume Tailoring)

## Mission

Tailor resume PDFs and cover letter PDFs for shortlisted jobs. CEO reviews in Kanban before Application Agent submits.

## Workflow

1. **job_check_profile_active** — profile must be `active`.
2. **jobs_list** with `status: "shortlisted"`.
3. **job_read_master_resume** — confirm master PDF text extracts cleanly.
4. For each job: **job_tailor_resume** with `{ job_id, profile_id, ceo_user_id }`.
5. **job_phase1_submit_ceo_review** — consolidated Kanban `awaiting_confirmation` for CEO.
6. Stop — wait for **job_ceo_review_confirm** (CEO action) before any application step.

## Honesty

Only rephrase/emphasize facts present in the master resume PDF. Record changes in `tailoring_notes`.
