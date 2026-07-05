/**
 * Smoke: jobs_append (discovered) → job_run_workflow_now → CEO Kanban task.
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { runJobSearchWorkflowNow } from '../backend/src/services/job-applicant-workflow-run.js';

initDb();

const RESUME = process.env.JOB_APPLICANT_RESUME_PATH || 'C:\\Users\\balaj\\Downloads\\Resume-Balaji.pdf';
const LINKEDIN = 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';

const CEO = `workflow-run-smoke-${Date.now()}`;
const PROFILE = `wf-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('✓', msg);
}

const profileSvc = createJobSearchProfileService(getDb);
const jobsSvc = createJobApplicationsService(getDb);

profileSvc.createProfile(CEO, { profile_id: PROFILE, display_name: 'Workflow smoke' });
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
});
profileSvc.confirm(CEO, PROFILE, true);

const appended = jobsSvc.append(
  [
    {
      source: 'jobstreet.com',
      company: 'Smoke Bank',
      title: 'Head of Engineering',
      location: 'Singapore',
      url: 'https://www.jobstreet.com.sg/jobs/smoke-wf-1',
    },
    {
      source: 'jobstreet.com',
      company: 'Smoke Tech',
      title: 'Engineering Director',
      location: 'Singapore',
      url: 'https://www.jobstreet.com.sg/jobs/smoke-wf-2',
    },
  ],
  { profile_id: PROFILE, ceo_user_id: CEO }
);
assert(appended.count_added === 2, 'Two jobs appended as discovered');

const beforeKanban = getDb()
  .prepare(`SELECT COUNT(*) as n FROM kanban_tasks WHERE description LIKE ?`)
  .get(`%ceo_review_profile:${PROFILE}%`);
assert(beforeKanban.n === 0, 'No CEO Kanban before workflow run');

for (const id of appended.added) {
  jobsSvc.update(id, {
    fit_score: 85,
    fit_rationale: 'Smoke test fit.',
    status: 'shortlisted',
  });
}

const result = await runJobSearchWorkflowNow(CEO, PROFILE, { scoreDiscovered: false });
assert(result.ok, 'workflow ok');
assert(result.kanban_task_id, `Kanban task #${result.kanban_task_id}`);
assert(result.awaiting_approval_count >= 1, 'At least one job awaiting approval');

const kanban = getDb().prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(result.kanban_task_id);
assert(kanban?.status === 'awaiting_confirmation', 'CEO review Kanban awaiting_confirmation');
assert(kanban.description.includes('ceo_review_profile:'), 'CEO review tag in description');
assert(result.next_step.includes('Kanban'), 'next_step mentions Kanban');

console.log('\nOK — workflow run smoke passed\n');
