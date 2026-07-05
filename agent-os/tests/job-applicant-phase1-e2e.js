/**
 * Phase 1 full E2E: JobStreet → Kanban CEO review → approve → prefill from resume + LinkedIn.
 *
 * Run: node tests/job-applicant-phase1-e2e.js
 */
import { existsSync, readFileSync } from 'fs';
import { initDb, getDb } from '../backend/src/db/schema.js';
import { seedJobApplicantToolsIfMissing } from '../backend/src/db/seed-job-applicant-tools.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { createJobApplicantSpreadsheetService } from '../backend/src/services/job-applicant-spreadsheet.js';
import { runPhase1SubmitCeoReview, confirmCeoReview } from '../backend/src/services/job-applicant-ceo-review.js';

const RESUME_PATH = 'C:\\Users\\balaj\\Downloads\\Resume-Balaji.pdf';
const LINKEDIN_PROFILE = process.env.JOB_APPLICANT_LINKEDIN || 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';
const BASE = process.env.AGENT_OS_BASE_URL || 'http://127.0.0.1:3001';

const JOBSTREET_JOBS = [
  {
    url: 'https://www.jobstreet.com.sg/job/head-of-engineering-dbs-123456',
    company: 'DBS Bank',
    title: 'Head of Engineering',
    location: 'Singapore',
    source: 'jobstreet.com',
    fit_score: 82,
  },
  {
    url: 'https://www.jobstreet.com.sg/job/head-of-cloud-ocbc-234567',
    company: 'OCBC Bank',
    title: 'Head of Cloud',
    location: 'Singapore',
    source: 'jobstreet.com',
    fit_score: 85,
  },
  {
    url: 'https://www.jobstreet.com.sg/job/executive-director-tech-uob-345678',
    company: 'UOB',
    title: 'Executive Director, Technology',
    location: 'Singapore',
    source: 'jobstreet.com',
    fit_score: 88,
  },
  {
    url: 'https://www.jobstreet.com.sg/job/junior-developer-999999',
    company: 'Small Fintech',
    title: 'Junior Developer',
    location: 'Singapore',
    source: 'jobstreet.com',
    fit_score: 65,
  },
];

initDb();
seedJobApplicantToolsIfMissing();

const profileSvc = createJobSearchProfileService(getDb);
const jobsSvc = createJobApplicationsService(getDb);
const sheetSvc = createJobApplicantSpreadsheetService(getDb);

const CEO = `phase1-full-${Date.now()}`;
const PROFILE = `tech-leadership-${Date.now()}`;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓', msg);
  } else {
    failed++;
    console.error('  ✗', msg);
  }
}

async function postTool(path, body) {
  const r = await fetch(`${BASE}/api/tools/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ceo-user-id': CEO },
    body: JSON.stringify({ ceo_user_id: CEO, profile_id: PROFILE, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function main() {
  console.log('\n=== Phase 1 E2E: JobStreet → Kanban → Approve → Prefill ===\n');
  console.log('CEO:', CEO);
  console.log('Profile:', PROFILE);
  console.log('Resume:', RESUME_PATH);
  console.log('LinkedIn:', LINKEDIN_PROFILE);

  assert(existsSync(RESUME_PATH), 'Master resume exists');

  profileSvc.createProfile(CEO, {
    profile_id: PROFILE,
    display_name: 'Tech Leadership — Head of Eng / Cloud / Exec Dir',
  });

  const saved = profileSvc.savePatch(CEO, PROFILE, {
    locations: ['Singapore'],
    work_mode: 'hybrid',
    work_authorization: 'Singapore PR',
    target_titles: ['Head of Engineering', 'Head of Cloud', 'Executive Director Technology'],
    seniority: 'executive',
    industries: ['banking', 'financial services', 'technology'],
    sources: ['jobstreet.com'],
    master_resume_path: RESUME_PATH,
    linkedin_profile: LINKEDIN_PROFILE,
    fit_threshold: 80,
    approval_channel: 'kanban',
    submit_policy: 'fill_and_stop',
    honesty_ack: 'yes',
    workflow_schedule: 'weekly',
    workflow_goal: 'job_application',
    cover_letter_policy: 'why_me_only',
  });

  assert(saved.intake_complete, 'Profile intake complete (resume + LinkedIn)');
  assert(saved.intake.linkedin_profile?.includes('linkedin.com'), 'LinkedIn profile stored');

  profileSvc.confirm(CEO, PROFILE, true);

  const append = jobsSvc.append(JOBSTREET_JOBS, { profile_id: PROFILE, ceo_user_id: CEO });
  assert(append.count_added === 4, 'Four JobStreet jobs appended');

  const jobIds = append.added;
  for (let i = 0; i < jobIds.length; i++) {
    const meta = JOBSTREET_JOBS[i];
    jobsSvc.update(jobIds[i], {
      fit_score: meta.fit_score,
      fit_rationale: `${meta.fit_score}% match for ${meta.title}.`,
      status: meta.fit_score >= 80 ? 'shortlisted' : 'skipped',
    });
  }

  const review = await runPhase1SubmitCeoReview({ ceoUserId: CEO, profileId: PROFILE });
  assert(review.kanban?.status === 'awaiting_confirmation', 'Kanban awaiting_confirmation');

  const db = getDb();
  const kanban = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(review.kanban.kanban_task_id);
  assert(kanban?.status === 'awaiting_confirmation', 'CEO review Kanban ready');
  assert(kanban.description.includes('linkedin.com'), 'Kanban summary includes LinkedIn profile');
  assert(kanban.description.includes('jobstreet.com'), 'Kanban summary includes JobStreet links');
  assert(kanban.description.includes('Head of Engineering'), 'Kanban shortlist summary present');
  assert(kanban.description.includes('profile_id'), 'Kanban shows which job profile');
  assert(kanban.description.includes('spreadsheet/download'), 'Kanban has working CSV download link');
  assert(!kanban.description.includes('1TestJobTracker'), 'No broken placeholder Google links');

  console.log(`\n  → Kanban #${kanban.id}: "${kanban.title}"`);
  console.log('  → Open UI: Kanban → Unassigned → Awaiting confirmation (or purple banner)\n');

  // CEO approves via Kanban tool equivalent
  const approval = await confirmCeoReview(CEO, PROFILE, true);
  assert(approval.count === 3, 'Three jobs approved on CEO confirm');
  assert(approval.prefill?.ok, 'Prefill ran from resume + LinkedIn');
  assert(approval.prefill?.results?.length === 3, 'Prefill for 3 jobs');

  const kanbanAfter = db.prepare('SELECT status FROM kanban_tasks WHERE id = ?').get(kanban.id);
  assert(kanbanAfter?.status === 'completed', 'CEO review Kanban marked completed after approve');

  for (const jid of approval.approved_job_ids) {
    const job = jobsSvc.get(jid);
    assert(job.status === 'approved', `Job ${jid} approved`);
    assert(job.prefill_status === 'ready' || job.prefill_fields, `Job ${jid} has prefill data`);
    assert(job.prefill_fields?.linkedin_url?.includes('linkedin.com'), `Job ${jid} prefill includes LinkedIn URL`);
    assert(job.prefill_fields?.resume_file, `Job ${jid} prefill includes resume path`);
  }

  assert(approval.prefill_kanban?.kanban_task_id, 'Prefill Kanban task created for Application Agent');
  const prefillKanban = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(approval.prefill_kanban.kanban_task_id);
  assert(prefillKanban?.status === 'in_progress', 'Prefill Kanban in_progress under Application Agent');

  try {
    const health = await fetch(`${BASE}/health`);
    if (health.ok) {
      console.log('\n--- HTTP ---');
      const http = await postTool('job-phase1-submit-ceo-review', { tailor_shortlisted: false });
      assert(http.ok, 'HTTP phase1 submit');
    }
  } catch (_) {}

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
  console.log('Phase 1 E2E SUCCESS\n');
  console.log('Kanban CEO review was at task #' + kanban.id + ' (awaiting_confirmation)');
  console.log('After approve: prefill task #' + approval.prefill_kanban.kanban_task_id + ' (in_progress → Application Agent)\n');
}

main().catch((e) => {
  console.error('E2E fatal:', e);
  process.exit(1);
});
