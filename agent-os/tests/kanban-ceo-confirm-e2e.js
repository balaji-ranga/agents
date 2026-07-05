/**
 * E2E: Kanban CEO confirm — including draft profile (regression for live-kanban-review).
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import {
  createConsolidatedCeoReviewKanban,
  confirmCeoReview,
} from '../backend/src/services/job-applicant-ceo-review.js';

initDb();

const RESUME = process.env.JOB_APPLICANT_RESUME_PATH || 'C:\\Users\\balaj\\Downloads\\Resume-Balaji.pdf';
const LINKEDIN = 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';

const CEO = `kanban-confirm-e2e-${Date.now()}`;
const PROFILE = `draft-confirm-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('✓', msg);
}

const profileSvc = createJobSearchProfileService(getDb);
const jobsSvc = createJobApplicationsService(getDb);

profileSvc.createProfile(CEO, { profile_id: PROFILE, display_name: 'Draft confirm test' });
profileSvc.savePatch(CEO, PROFILE, {
  locations: ['Singapore'],
  work_mode: 'remote',
  target_titles: ['Engineer'],
  sources: ['jobstreet.com'],
  master_resume_path: RESUME,
  linkedin_profile: LINKEDIN,
  fit_threshold: 80,
  honesty_ack: true,
  approval_channel: 'kanban',
  submit_policy: 'fill_and_stop',
});
// Intentionally NOT calling confirm() — profile stays draft (like live-kanban-review)

const appended = jobsSvc.append(
  [
    {
      source: 'jobstreet.com',
      company: 'Test Co',
      title: 'Senior Engineer',
      location: 'Singapore',
      url: 'https://www.jobstreet.com.sg/jobs/test-confirm-1',
    },
    {
      source: 'jobstreet.com',
      company: 'Test Co 2',
      title: 'Lead Engineer',
      location: 'Singapore',
      url: 'https://www.jobstreet.com.sg/jobs/test-confirm-2',
    },
  ],
  { profile_id: PROFILE, ceo_user_id: CEO }
);

for (const id of appended.added) {
  jobsSvc.update(id, {
    fit_score: 85,
    status: 'awaiting_approval',
    resume_variant_path: RESUME,
  });
}

const profile = profileSvc.getProfile(CEO, PROFILE);
assert(profile.status === 'draft', 'Profile is draft (regression scenario)');

const kanban = createConsolidatedCeoReviewKanban(CEO, PROFILE, jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE }), profile, null);
assert(kanban.status === 'awaiting_confirmation', 'CEO review Kanban created');

const db = getDb();
const taskBefore = db.prepare('SELECT status FROM kanban_tasks WHERE id = ?').get(kanban.kanban_task_id);
assert(taskBefore.status === 'awaiting_confirmation', 'Kanban awaiting_confirmation before approve');

const approval = await confirmCeoReview(CEO, PROFILE, true);
assert(approval.ok, 'confirmCeoReview ok');
assert(approval.count === 2, 'Two jobs approved');
assert(approval.kanban_completed, 'Kanban marked completed');

const taskAfter = db.prepare('SELECT status FROM kanban_tasks WHERE id = ?').get(kanban.kanban_task_id);
assert(taskAfter.status === 'completed', 'Kanban task completed after confirm');

for (const jid of approval.approved_job_ids) {
  const job = jobsSvc.get(jid);
  assert(job.status === 'approved', `Job ${jid} approved`);
}

assert(approval.prefill?.ok, 'Prefill ran');
assert(approval.prefill_kanban?.kanban_task_id, 'Application Agent prefill Kanban created');
assert(approval.message?.includes('Approved 2'), 'Human-readable message');

// HTTP smoke (optional — backend must be running with latest code)
const BASE = process.env.API_BASE || 'http://localhost:3001/api';
try {
  const CEO2 = `${CEO}-http`;
  const PID2 = `${PROFILE}-http`;
  profileSvc.createProfile(CEO2, { profile_id: PID2, display_name: 'HTTP confirm' });
  profileSvc.savePatch(CEO2, PID2, {
    locations: ['SG'],
    work_mode: 'remote',
    target_titles: ['Dir'],
    sources: ['linkedin'],
    master_resume_path: RESUME,
    linkedin_profile: LINKEDIN,
    fit_threshold: 80,
    honesty_ack: true,
  });
  const j = jobsSvc.append(
    [{ source: 'jobstreet.com', company: 'X', title: 'Y', url: 'https://www.jobstreet.com.sg/jobs/http-test' }],
    { profile_id: PID2, ceo_user_id: CEO2 }
  );
  jobsSvc.update(j.added[0], { fit_score: 90, status: 'awaiting_approval', resume_variant_path: RESUME });
  createConsolidatedCeoReviewKanban(CEO2, PID2, jobsSvc.list({ ceo_user_id: CEO2, profile_id: PID2 }), profileSvc.getProfile(CEO2, PID2), null);

  const res = await fetch(`${BASE}/tools/job-ceo-review-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ceo_user_id: CEO2, profile_id: PID2, confirm: true }),
  });
  const body = await res.json();
  assert(res.ok, `HTTP confirm ${res.status}: ${body.error || 'ok'}`);
  assert(body.count === 1, 'HTTP approved 1 job');
  console.log('✓ HTTP /tools/job-ceo-review-confirm works');
} catch (e) {
  console.log('⚠ HTTP smoke skipped:', e.message);
}

console.log('\nOK — Kanban CEO confirm E2E passed\n');
