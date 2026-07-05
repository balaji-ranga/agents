/**
 * Smoke: scoring_summary profile → CEO confirm → acknowledged (no application agent).
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { runPhase1SubmitCeoReview, confirmCeoReview } from '../backend/src/services/job-applicant-ceo-review.js';

initDb();

const RESUME = process.env.JOB_APPLICANT_RESUME_PATH || 'C:\\Users\\balaj\\Downloads\\Resume-Balaji.pdf';
const LINKEDIN = 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';

const CEO = `goal-smoke-${Date.now()}`;
const PROFILE = `scoring-only-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('✓', msg);
}

const profileSvc = createJobSearchProfileService(getDb);
const jobsSvc = createJobApplicationsService(getDb);

profileSvc.createProfile(CEO, { profile_id: PROFILE, display_name: 'Scoring only' });
profileSvc.savePatch(CEO, PROFILE, {
  locations: ['Singapore'],
  work_mode: 'remote',
  target_titles: ['Director'],
  sources: ['jobstreet.com'],
  master_resume_path: RESUME,
  linkedin_profile: LINKEDIN,
  fit_threshold: 70,
  honesty_ack: true,
  approval_channel: 'kanban',
  submit_policy: 'fill_and_stop',
  workflow_goal: 'scoring_summary',
});
profileSvc.confirm(CEO, PROFILE, true);

const appended = jobsSvc.append(
  [{ source: 'jobstreet.com', company: 'GoalCo', title: 'Director Tech', url: 'https://www.jobstreet.com.sg/jobs/goal-smoke-1', location: 'SG' }],
  { profile_id: PROFILE, ceo_user_id: CEO }
);
jobsSvc.update(appended.added[0], { fit_score: 88, status: 'awaiting_approval', resume_variant_path: RESUME });

const review = await runPhase1SubmitCeoReview({ ceoUserId: CEO, profileId: PROFILE, tailorShortlisted: false });
assert(review.kanban?.kanban_task_id, 'CEO review Kanban created');

const desc = getDb().prepare('SELECT description FROM kanban_tasks WHERE id = ?').get(review.kanban.kanban_task_id);
assert(desc.description.includes('workflow_goal: scoring_summary'), 'Kanban shows scoring goal');

const confirm = await confirmCeoReview(CEO, PROFILE, true);
assert(confirm.post_action === 'acknowledged', 'post_action acknowledged');
assert(confirm.requires_job_application === false, 'no application required');
assert(confirm.count === 1, 'one job processed');
assert(!confirm.prefill_kanban?.kanban_task_id, 'no prefill kanban');

const job = jobsSvc.get(appended.added[0]);
assert(job.status === 'acknowledged', 'job status acknowledged');
assert(job.owner_action === 'acknowledge', 'owner_action acknowledge');

console.log('\nOK — workflow_goal scoring_summary confirm passed\n');
