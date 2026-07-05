/**
 * Draft profiles must not run discovery append or workflow.
 * Run: node tests/job-applicant-draft-profile-guard.js
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { seedJobApplicantToolsIfMissing } from '../backend/src/db/seed-job-applicant-tools.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { runJobSearchWorkflowNow, runJobPipelineStart } from '../backend/src/services/job-applicant-workflow-run.js';

initDb();
seedJobApplicantToolsIfMissing();

const CEO = 'default';
const PROFILE = 'draft-guard-test';
const profileSvc = createJobSearchProfileService(getDb);

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

function assertThrows(fn, pattern, msg) {
  try {
    fn();
    failed++;
    console.error('  ✗', msg, '(expected throw)');
  } catch (e) {
    const ok = !pattern || new RegExp(pattern, 'i').test(e.message || '');
    if (ok) {
      passed++;
      console.log('  ✓', msg);
    } else {
      failed++;
      console.error('  ✗', msg, `— got: ${e.message}`);
    }
  }
}

async function assertThrowsAsync(fn, pattern, msg) {
  try {
    await fn();
    failed++;
    console.error('  ✗', msg, '(expected throw)');
  } catch (e) {
    const ok = !pattern || new RegExp(pattern, 'i').test(e.message || '');
    if (ok) {
      passed++;
      console.log('  ✓', msg);
    } else {
      failed++;
      console.error('  ✗', msg, `— got: ${e.message}`);
    }
  }
}

async function toolPost(path, body) {
  const BASE = process.env.AGENT_OS_BASE_URL || 'http://127.0.0.1:3001';
  const res = await fetch(`${BASE.replace(/\/$/, '')}/api/tools${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ceo-user-id': CEO },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log('\n=== Draft profile guard ===\n');

profileSvc.createProfile(CEO, { profile_id: PROFILE, display_name: 'Draft guard test' });
const saved = profileSvc.savePatch(CEO, PROFILE, {
  locations: ['Singapore'],
  work_mode: 'hybrid',
  target_titles: ['SVP Technology'],
  sources: ['linkedin.com', 'jobstreet.com.sg'],
  master_resume_path: '1_foundations/me/Bala_resume_latest.pdf',
  linkedin_profile: 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/',
  fit_threshold: 75,
  approval_channel: 'kanban',
  submit_policy: 'fill_and_stop',
  honesty_ack: true,
  workflow_goal: 'job_application',
  workflow_schedule: 'manual',
});
assert(saved.status === 'draft', 'Profile stays draft after intake patch');
assert(saved.intake_complete, 'Intake complete but still draft until confirm');

const gate = profileSvc.assertActive(CEO, PROFILE);
assert(!gate.active && gate.status === 'draft', 'assertActive rejects draft');

assertThrows(
  () => runJobPipelineStart(CEO, PROFILE),
  'draft',
  'runJobPipelineStart rejects draft profile'
);

await assertThrowsAsync(
  () => runJobSearchWorkflowNow(CEO, PROFILE),
  'draft',
  'runJobSearchWorkflowNow rejects draft profile'
);

const appendRes = await toolPost('/jobs-append', {
  profile_id: PROFILE,
  ceo_user_id: CEO,
  jobs: [{ url: 'https://www.linkedin.com/jobs/view/1234567890', title: 'Test', company: 'Bank', source: 'linkedin' }],
});
assert(appendRes.status === 403, `jobs_append HTTP 403 (got ${appendRes.status})`);
assert(/draft|not active/i.test(appendRes.data?.error || ''), 'jobs_append error mentions draft/inactive');

const workflowRes = await toolPost('/job-run-workflow-now', {
  profile_id: PROFILE,
  ceo_user_id: CEO,
});
assert(workflowRes.status >= 400, `job_run_workflow_now HTTP error (got ${workflowRes.status})`);
assert(/draft/i.test(workflowRes.data?.error || ''), 'job_run_workflow_now error mentions draft');

const confirmed = profileSvc.confirm(CEO, PROFILE, true);
assert(confirmed.status === 'active', 'Profile active after confirm');
const gate2 = profileSvc.assertActive(CEO, PROFILE);
assert(gate2.active, 'assertActive passes after confirm');

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
