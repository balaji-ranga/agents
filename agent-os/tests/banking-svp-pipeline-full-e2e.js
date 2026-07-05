/**
 * Full banking SVP pipeline E2E: cleanup → server harvest discovery → fit score → tailor → CEO Kanban.
 * Prereqs: OpenClaw gateway (18789), browser profile logged into LinkedIn/JobStreet.
 * Run: node tests/banking-svp-pipeline-full-e2e.js
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { initDb, getDb } from '../backend/src/db/schema.js';
import { seedJobApplicantToolsIfMissing } from '../backend/src/db/seed-job-applicant-tools.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { runFullJobWorkflow } from '../backend/src/services/job-applicant-workflow-run.js';
import { processPendingDelegationTasks } from '../backend/src/services/delegation-queue.js';
import { isJobListingUrl } from '../backend/src/services/job-url-validation.js';
import { resolveSafeMaterialPath } from '../backend/src/services/job-applicant-pdf.js';
import { buildJobMaterialLinks } from '../backend/src/services/job-applicant-links.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const RESUME = join(AGENT_OS_ROOT, '..', '1_foundations', 'me', 'Bala_resume_latest.pdf');
const GATEWAY = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const CEO = 'default';
const PROFILE = 'banking-svp-cloud-sg';
const MIN_JOBS = Number(process.env.E2E_MIN_JOBS || 6);
const POLL_MS = 12000;
const MAX_WAIT_MS = Number(process.env.E2E_MAX_WAIT_MS || 900000);

function loadEnv() {
  const envPath = join(AGENT_OS_ROOT, 'backend', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}

loadEnv();
initDb();
seedJobApplicantToolsIfMissing();

const db = getDb();
const profileSvc = createJobSearchProfileService(() => db);
const jobsSvc = createJobApplicationsService(() => db);

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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setupProfile() {
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
    target_titles: ['Senior Vice President Technology', 'SVP Cloud', 'Head of Cloud', 'Executive Director Technology'],
    seniority: 'executive',
    industries: ['banking', 'financial services'],
    sources: ['linkedin.com', 'jobstreet.com.sg'],
    master_resume_path: RESUME,
    fit_threshold: 75,
    approval_channel: 'kanban',
    submit_policy: 'fill_and_stop',
    honesty_ack: true,
    workflow_goal: 'job_application',
    workflow_schedule: 'manual',
    cover_letter_policy: 'full letter',
    discovery_min_per_source: 5,
    discovery_max_per_run: 25,
    discovery_depth: { linkedin_pages: 3, jobstreet_pages: 3 },
  });
  profileSvc.confirm(CEO, PROFILE, true);
  profileSvc.setActiveProfile(CEO, PROFILE);
}

async function main() {
  console.log('\n=== Banking SVP full pipeline E2E ===\n');

  const gw = await fetch(`${GATEWAY.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  assert(gw?.ok, `Gateway reachable (${GATEWAY})`);
  assert(existsSync(RESUME), 'Master resume PDF exists');

  console.log('\n1. Cleanup all jobs, tasks, chats…');
  execSync('node backend/scripts/cleanup-all-jobs.js', { cwd: AGENT_OS_ROOT, stdio: 'inherit' });

  console.log('\n2. Setup profile…');
  setupProfile();
  assert(profileSvc.getProfile(CEO, PROFILE)?.status === 'active', 'Profile active');

  console.log('\n3. Start full workflow (server harvest + agent pipeline)…');
  const started = await runFullJobWorkflow(CEO, PROFILE, { forceDiscovery: true });
  assert(started?.ok !== false, `Workflow started (${started?.error || started?.mode || 'unknown'})`);
  if (!started?.ok) {
    console.error('   Start error:', started?.error);
    process.exit(1);
  }
  console.log('   Mode:', started.mode, '| discovered:', started.discovered_count ?? 'pending');

  console.log('\n4. Process delegations until CEO review or timeout…');
  const t0 = Date.now();
  let ceoKanban = null;
  let lastDiscovered = 0;

  while (Date.now() - t0 < MAX_WAIT_MS) {
    await processPendingDelegationTasks().catch((e) => console.warn('   delegation:', e.message));

    const discovered = jobsSvc.list({ status: 'discovered', ceo_user_id: CEO, profile_id: PROFILE, limit: 100 });
    const shortlisted = jobsSvc.list({ status: 'shortlisted', ceo_user_id: CEO, profile_id: PROFILE, limit: 100 });
    const awaiting = jobsSvc.list({ status: 'awaiting_approval', ceo_user_id: CEO, profile_id: PROFILE, limit: 100 });
    const allJobs = [...discovered, ...shortlisted, ...awaiting];

    if (allJobs.length !== lastDiscovered) {
      console.log(
        `   ${new Date().toISOString().slice(11, 19)} jobs: discovered=${discovered.length} shortlisted=${shortlisted.length} awaiting=${awaiting.length}`
      );
      lastDiscovered = allJobs.length;
    }

    ceoKanban = db
      .prepare(
        `SELECT id, status, title FROM kanban_tasks WHERE description LIKE ? ORDER BY id DESC LIMIT 1`
      )
      .get(`%ceo_review_profile:${PROFILE}%`);

    if (ceoKanban?.status === 'awaiting_confirmation' && awaiting.length >= 1) break;
    await sleep(POLL_MS);
  }

  console.log('\n5. Verify jobs…');
  const trackerJobs = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 100 });
  const realListings = trackerJobs.filter(
    (j) => isJobListingUrl(j.url) && j.title?.trim() && j.company?.trim() && j.company.toLowerCase() !== 'linkedin'
  );

  assert(realListings.length >= MIN_JOBS, `${MIN_JOBS}+ real job listings (found ${realListings.length})`);
  for (const j of realListings.slice(0, 8)) {
    console.log(`     → ${j.company} | ${j.title} | ${j.url?.slice(0, 70)}…`);
  }

  console.log('\n6. Verify CEO Kanban + cover letter PDFs…');
  assert(ceoKanban?.id, `CEO review Kanban #${ceoKanban?.id || '?'}`);
  assert(
    ceoKanban?.status === 'awaiting_confirmation',
    `Kanban status: ${ceoKanban?.status}`
  );

  const awaitingJobs = jobsSvc.list({ status: 'awaiting_approval', ceo_user_id: CEO, profile_id: PROFILE, limit: 50 });
  assert(awaitingJobs.length >= 1, `Jobs awaiting approval: ${awaitingJobs.length}`);

  let pdfOk = 0;
  for (const job of awaitingJobs.slice(0, 5)) {
    const path = resolveSafeMaterialPath(CEO, PROFILE, job.job_id, 'cover-letter');
    const links = buildJobMaterialLinks(CEO, PROFILE, job.job_id);
    assert(path && existsSync(path), `Cover letter PDF on disk: ${job.title || job.job_id}`);
    assert(links.cover_letter_pdf.startsWith('/api/'), 'Cover letter API link is relative /api/ path');
    if (path && existsSync(path)) pdfOk++;
  }
  assert(pdfOk >= 1, `Cover letter PDFs generated (${pdfOk})`);

  const wf = db
    .prepare(
      `SELECT id, workflow_number, status FROM job_workflow_runs WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(PROFILE);
  assert(wf?.id, `Workflow #${wf?.workflow_number}`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
  console.log('PIPELINE E2E SUCCESS');
  console.log(`Kanban CEO review: #${ceoKanban.id} | Workflow #${wf.workflow_number} | Jobs: ${realListings.length}\n`);
}

main().catch((e) => {
  console.error('\nFatal:', e.message || e);
  process.exit(1);
});
