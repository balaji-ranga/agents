/**
 * Smoke: workflow run tracking — numbered runs, steps, audit trail, list/get API.
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { runJobSearchWorkflowNow } from '../backend/src/services/job-applicant-workflow-run.js';
import { confirmCeoReview } from '../backend/src/services/job-applicant-ceo-review.js';
import { getJobWorkflowTracker } from '../backend/src/services/job-workflow-tracker.js';

initDb();

const RESUME = process.env.JOB_APPLICANT_RESUME_PATH || 'C:\\Users\\balaj\\Downloads\\Resume-Balaji.pdf';
const LINKEDIN = 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';

const CEO = `wf-tracker-smoke-${Date.now()}`;
const PROFILE = `wft-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('✓', msg);
}

const profileSvc = createJobSearchProfileService(getDb);
const jobsSvc = createJobApplicationsService(getDb);
const tracker = getJobWorkflowTracker();

profileSvc.createProfile(CEO, { profile_id: PROFILE, display_name: 'Tracker smoke' });
profileSvc.savePatch(CEO, PROFILE, {
  locations: ['Singapore'],
  work_mode: 'remote',
  target_titles: ['Head of Engineering'],
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

const wf1 = tracker.startRun({
  ceoUserId: CEO,
  profileId: PROFILE,
  workflowGoal: 'scoring_summary',
  trigger: 'test',
  actor: { type: 'user', id: CEO },
});
assert(wf1.workflow_number === 1, 'First workflow number is 1');
assert(wf1.steps?.length >= 7, 'Scoring summary template has steps');

const appended = jobsSvc.append(
  [
    {
      source: 'jobstreet.com',
      company: 'Tracker Co',
      title: 'Head of Engineering',
      location: 'Singapore',
      url: `https://www.jobstreet.com.sg/jobs/tracker-${Date.now()}`,
    },
  ],
  { profile_id: PROFILE, ceo_user_id: CEO }
);
assert(appended.count_added === 1, 'One job appended');

for (const id of appended.added) {
  jobsSvc.update(id, { fit_score: 88, fit_rationale: 'Good fit.', status: 'shortlisted' });
}

const result = await runJobSearchWorkflowNow(CEO, PROFILE, {
  scoreDiscovered: false,
  actor: { type: 'agent', id: 'jobdiscovery' },
});
assert(result.workflow_id, 'workflow_id returned');
assert(result.workflow_number === 1, 'Reuses active run (same number)');
assert(result.workflow?.steps?.some((s) => s.step_key === 'ceo_confirm' && s.status === 'in_progress'), 'ceo_confirm in progress');

const confirm = await confirmCeoReview(CEO, PROFILE, true, {
  actor: { type: 'user', id: CEO },
  workflow_run_id: result.workflow_id,
});
assert(confirm.workflow_id === result.workflow_id, 'Confirm returns workflow_id');
assert(confirm.workflow?.status === 'completed', 'Scoring summary workflow completed');

const audit = confirm.workflow?.audit_trail || [];
assert(audit.some((e) => e.step_key === 'ceo_confirm' && e.event === 'completed'), 'CEO confirm in audit trail');
assert(audit.some((e) => e.actor_type === 'user'), 'User actor in audit trail');

const runs = tracker.listRuns(CEO, PROFILE);
assert(runs.length >= 1, 'listRuns returns runs');
assert(runs[0].workflow_number === 1, 'listRuns has workflow_number');

const byId = tracker.getRun(result.workflow_id);
assert(byId.profile_id === PROFILE, 'getRun by id');

const wf2start = tracker.startRun({
  ceoUserId: CEO,
  profileId: PROFILE,
  workflowGoal: 'scoring_summary',
  trigger: 'test2',
});
assert(wf2start.workflow_number === 2, 'Second run increments workflow_number');

console.log('\nOK — workflow tracker smoke passed\n');
