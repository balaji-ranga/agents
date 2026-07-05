/**
 * Real pipeline E2E: LinkedIn + JobStreet discovery → fit scoring → resume tailor → CEO confirm.
 * No dummy/test-bank jobs. Uses server harvest + agent delegations as needed.
 *
 * Prereqs: backend running, OpenClaw gateway up, browser logged into LinkedIn/JobStreet.
 * Usage: node backend/scripts/test-pipeline-discovery-success.js
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../src/db/schema.js';
import { getJobWorkflowTracker } from '../src/services/job-workflow-tracker.js';
import {
  startPipeline,
  failPipelineWorkflowForDelegation,
} from '../src/services/job-applicant-pipeline.js';
import { processPendingDelegationTasks } from '../src/services/delegation-queue.js';
import { createJobApplicationsService } from '../src/services/job-applications.js';
import { createJobSearchProfileService } from '../src/services/job-search-profile.js';
import { getDefaultCeoUserId } from '../src/services/job-applicant-ceo.js';
import { getBrowserAuthStatus } from '../src/services/job-browser-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..', '..');
const RESUME_PATH = join(AGENT_OS_ROOT, '..', '1_foundations', 'me', 'Bala_resume_latest.pdf');
const LINKEDIN = 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';

const CEO = getDefaultCeoUserId();
const PROFILE = process.env.TEST_PROFILE_ID || 'banking-svp-cloud-sg';
const LOOP_TIMEOUT_MS = Number(process.env.PIPELINE_E2E_TIMEOUT_MS || 1800000);
const LOOP_INTERVAL_MS = Number(process.env.PIPELINE_E2E_POLL_MS || 8000);
const PLACEHOLDER_URL = /smoke|placeholder|123456|999999|example\.com|test-job|test bank|test finance/i;

initDb();

function db() {
  return getDb();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function repairStuckRuns() {
  const tracker = getJobWorkflowTracker();
  const runs = db()
    .prepare(`SELECT id FROM job_workflow_runs WHERE status = 'running' AND profile_id = ?`)
    .all(PROFILE);
  for (const r of runs) {
    const wf = tracker.getRun(r.id);
    const ceoConfirm = wf.steps?.find((s) => s.step_key === 'ceo_confirm');
    if (ceoConfirm?.status === 'in_progress' || ceoConfirm?.status === 'completed') {
      console.log('Keeping workflow run', r.id, 'at CEO confirm stage');
      continue;
    }
    tracker.repairStuckSteps(r.id);
    tracker.failInProgressStep(r.id, { type: 'system', id: 'test_repair' }, { reason: 'test cleanup' });
    console.log('Repaired stuck workflow run', r.id);
  }

  const staleDelegations = db()
    .prepare(
      `SELECT * FROM agent_delegation_tasks WHERE status IN ('pending', 'processing') AND prompt LIKE '[job_pipeline%'`
    )
    .all();
  for (const d of staleDelegations) {
    db()
      .prepare(
        `UPDATE agent_delegation_tasks SET status = 'failed', error_message = 'cleared for test', completed_at = datetime('now') WHERE id = ?`
      )
      .run(d.id);
    failPipelineWorkflowForDelegation({ ...d, status: 'failed', error_message: 'cleared for test' });
  }
  console.log('Cleared', staleDelegations.length, 'stale pipeline delegations');
}

function purgeDummyJobs() {
  const jobs = createJobApplicationsService(() => getDb());
  const all = jobs.list({ profile_id: PROFILE, ceo_user_id: CEO, limit: 500 });
  let removed = 0;
  for (const j of all) {
    const url = String(j.url || '');
    const company = String(j.company || '');
    if (PLACEHOLDER_URL.test(url) || PLACEHOLDER_URL.test(company) || PLACEHOLDER_URL.test(j.title || '')) {
      db().prepare('DELETE FROM job_applications WHERE job_id = ?').run(j.job_id);
      removed++;
    }
  }
  console.log('Purged', removed, 'dummy/test jobs for profile', PROFILE);
}

function setupProfile() {
  const profileSvc = createJobSearchProfileService(() => getDb());
  const existing = profileSvc.getProfile(CEO, PROFILE);
  if (existing.status === 'none') {
    profileSvc.createProfile(CEO, {
      profile_id: PROFILE,
      display_name: 'Banking SVP — Technology & Cloud (Singapore)',
    });
  }

  profileSvc.savePatch(CEO, PROFILE, {
    locations: ['Singapore'],
    work_mode: 'hybrid',
    work_authorization: 'Singapore PR / Citizen',
    target_titles: [
      'Senior Vice President Technology',
      'SVP Cloud',
      'Head of Cloud',
      'Executive Director Technology',
      'VP Technology Banking',
    ],
    seniority: 'executive',
    industries: ['banking', 'financial services', 'technology'],
    industry_exclusions: [],
    sources: ['linkedin.com', 'jobstreet.com.sg', 'jobstreet.com'],
    master_resume_path: existsSync(RESUME_PATH) ? RESUME_PATH : undefined,
    linkedin_profile: LINKEDIN,
    fit_threshold: 75,
    approval_channel: 'kanban',
    submit_policy: 'fill_and_stop',
    honesty_ack: true,
    workflow_goal: 'job_application',
    workflow_schedule: 'manual',
    cover_letter_policy: 'why_me_only',
    max_discoveries_per_week: 15,
    max_applications_per_week: 5,
  });

  profileSvc.confirm(CEO, PROFILE, true);
  profileSvc.setActiveProfile(CEO, PROFILE);
  console.log('Profile active:', PROFILE);
}

function pendingPipelineCount() {
  return db()
    .prepare(
      `SELECT COUNT(*) AS c FROM agent_delegation_tasks
       WHERE status IN ('pending', 'processing') AND prompt LIKE '[job_pipeline%'`
    )
    .get().c;
}

function isRealPortalJob(j) {
  const url = String(j.url || '');
  return (
    url &&
    (url.includes('linkedin.com/jobs') || url.includes('jobstreet.com')) &&
    !PLACEHOLDER_URL.test(url)
  );
}

async function runPipelineToCeoConfirm() {
  const deadline = Date.now() + LOOP_TIMEOUT_MS;
  let iteration = 0;

  while (Date.now() < deadline) {
    iteration++;
    const pending = pendingPipelineCount();
    console.log(`\n--- Delegation loop #${iteration} (pending: ${pending}) ---`);
    await processPendingDelegationTasks();

    const wfRow = db()
      .prepare(
        `SELECT id FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(CEO, PROFILE);
    if (!wfRow?.id) break;

    const tracker = getJobWorkflowTracker();
    const wf = tracker.getRun(wfRow.id);
    const ceoConfirm = wf.steps.find((s) => s.step_key === 'ceo_confirm');
    const ceoReview = wf.steps.find((s) => s.step_key === 'ceo_review');

    console.log(
      'Workflow',
      wf.workflow_number,
      '| status:',
      wf.status,
      '| progress:',
      wf.progress.percent + '%',
      '| ceo_review:',
      ceoReview?.status,
      '| ceo_confirm:',
      ceoConfirm?.status
    );

    if (wf.status === 'failed') {
      throw new Error(`Workflow failed at ${wf.progress.percent}%`);
    }

    if (ceoConfirm?.status === 'in_progress' || ceoConfirm?.status === 'completed') {
      return wf;
    }

    if (pendingPipelineCount() === 0 && ceoReview?.status === 'completed') {
      return wf;
    }

    if (pendingPipelineCount() === 0 && wf.status !== 'running') {
      return wf;
    }

    await sleep(LOOP_INTERVAL_MS);
  }

  throw new Error(`Timed out after ${LOOP_TIMEOUT_MS / 1000}s waiting for CEO confirm stage`);
}

async function main() {
  console.log('=== Pipeline E2E: real LinkedIn + JobStreet → CEO confirm ===\n');

  const auth = getBrowserAuthStatus();
  console.log('Browser session:', {
    session_ready: auth.session_ready,
    linkedin: auth.linkedin_logged_in,
    jobstreet: auth.jobstreet_logged_in,
  });
  if (!auth.session_ready) {
    console.warn('WARNING: Browser may not be logged in — harvest/discovery may return 0 jobs.');
  }

  repairStuckRuns();
  purgeDummyJobs();
  setupProfile();

  console.log('\n--- startPipeline (real server harvest + delegations) ---');
  const started = await startPipeline(CEO, PROFILE);
  console.log(JSON.stringify({ mode: started.mode, workflow_id: started.workflow_id, discovered_count: started.discovered_count }, null, 2));

  const wfId = started.workflow_id;
  if (!wfId) {
    console.error('FAIL: no workflow_id');
    process.exit(1);
  }

  const wf = await runPipelineToCeoConfirm();

  const jobs = createJobApplicationsService(() => getDb()).list({
    profile_id: PROFILE,
    ceo_user_id: CEO,
    limit: 100,
  });
  const realJobs = jobs.filter(isRealPortalJob);
  const linkedinJobs = realJobs.filter((j) => j.url.includes('linkedin.com'));
  const jobstreetJobs = realJobs.filter((j) => j.url.includes('jobstreet.com'));

  console.log('\n--- Jobs discovered ---');
  console.log('Total jobs:', jobs.length, '| Real portal URLs:', realJobs.length);
  console.log('LinkedIn:', linkedinJobs.length, '| JobStreet:', jobstreetJobs.length);
  for (const j of realJobs.slice(0, 6)) {
    console.log(`  → ${j.company || '?'} | ${j.title || '?'} | ${j.status} | ${j.url}`);
  }

  const discovery = wf.steps.find((s) => s.step_key === 'job_discovery');
  const fit = wf.steps.find((s) => s.step_key === 'fit_scoring');
  const tailor = wf.steps.find((s) => s.step_key === 'resume_tailoring');
  const ceoReview = wf.steps.find((s) => s.step_key === 'ceo_review');
  const ceoConfirm = wf.steps.find((s) => s.step_key === 'ceo_confirm');

  const ceoKanban = db()
    .prepare(
      `SELECT id, title, status FROM kanban_tasks WHERE description LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%ceo_review_profile:${PROFILE}%`);

  console.log('\n--- Workflow steps ---');
  console.log('job_discovery:', discovery?.status);
  console.log('fit_scoring:', fit?.status);
  console.log('resume_tailoring:', tailor?.status);
  console.log('ceo_review:', ceoReview?.status);
  console.log('ceo_confirm:', ceoConfirm?.status);
  console.log('CEO Kanban:', ceoKanban ? `#${ceoKanban.id} (${ceoKanban.status})` : 'none');

  let failed = false;
  if (realJobs.length < 1) {
    console.error('\nFAIL: No real LinkedIn/JobStreet jobs in tracker');
    failed = true;
  }
  if (discovery?.status !== 'completed') {
    console.error('\nFAIL: job_discovery not completed (got', discovery?.status + ')');
    failed = true;
  }
  if (fit?.status !== 'completed') {
    console.error('\nFAIL: fit_scoring not completed (got', fit?.status + ')');
    failed = true;
  }
  if (tailor?.status !== 'completed') {
    console.error('\nFAIL: resume_tailoring not completed (got', tailor?.status + ')');
    failed = true;
  }
  if (ceoReview?.status !== 'completed') {
    console.error('\nFAIL: ceo_review not completed (got', ceoReview?.status + ')');
    failed = true;
  }
  if (ceoConfirm?.status !== 'in_progress' && ceoConfirm?.status !== 'completed') {
    console.error('\nFAIL: ceo_confirm not reached (got', ceoConfirm?.status + ')');
    failed = true;
  }
  if (!ceoKanban?.id) {
    console.error('\nFAIL: No CEO review Kanban task');
    failed = true;
  } else if (ceoKanban.status !== 'awaiting_confirmation' && ceoKanban.status !== 'completed') {
    console.error('\nFAIL: CEO Kanban not awaiting confirmation (got', ceoKanban.status + ')');
    failed = true;
  }
  if (wf.progress.percent < 50) {
    console.error('\nFAIL: workflow progress too low:', wf.progress.percent + '%');
    failed = true;
  }

  if (failed) process.exit(1);

  console.log('\nPASS: Real discovery completed; workflow at CEO confirmation stage');
  console.log(`Workflow #${wf.workflow_number} (id ${wf.workflow_id}) — ${wf.progress.percent}%`);
  console.log(`Kanban CEO review: #${ceoKanban.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
