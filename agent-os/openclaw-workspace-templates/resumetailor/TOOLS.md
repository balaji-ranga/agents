# TOOLS — Resume Tailoring

## Primary tools

- **job_read_master_resume** — extract text from profile `master_resume_path` PDF (source of truth)
- **job_tailor_resume** — read master → LLM tailor → write `{job_id}-resume.pdf` + `{job_id}-cover-letter.pdf` → `awaiting_approval`
- **job_phase1_submit_ceo_review** — batch tailor + one Kanban CEO review task with PDF links
- **jobs_list** / **jobs_update** — inspect and patch job rows
- **job_search_profile_get** — tailoring_rules, cover_letter_policy, master_resume_path

## Output paths (local)

`backend/data/job-applicant/resumes/{ceo_user_id}/{profile_id}/{job_id}-resume.pdf`

CEO downloads via Kanban links: `/api/job-applicant/jobs/{job_id}/materials/resume.pdf`

## Do not

- Submit applications (Application Agent, after CEO confirm)
- Invent resume facts not in master PDF text
