/**
 * Real E2E: Job Discovery agent → browser search (LinkedIn + JobStreet) → jobs_append → workflow → Kanban.
 *
 * Prereqs: backend (3001), OpenClaw gateway (18789), jobdiscovery agent + browser tools.
 * Run: node tests/job-applicant-discovery-e2e.js
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../backend/src/db/schema.js';
import { seedJobApplicantToolsIfMissing } from '../backend/src/db/seed-job-applicant-tools.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { getSpreadsheetPaths } from '../backend/src/services/job-applicant-spreadsheet.js';
import * as openclaw from '../backend/src/gateway/openclaw.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const BASE = process.env.AGENT_OS_BASE_URL || 'http://127.0.0.1:3001';
const GATEWAY = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const CEO = process.env.AGENT_OS_CEO_USER_ID || 'default';
const PROFILE = 'banking-svp-cloud-sg';
const RESUME_PATH = join(AGENT_OS_ROOT, '..', '1_foundations', 'me', 'Bala_resume_latest.pdf');
const LINKEDIN = 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';
const CHAT_TIMEOUT_MS = Number(process.env.E2E_CHAT_TIMEOUT_MS || 600000);

const envPath = join(AGENT_OS_ROOT, 'backend', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}

const PLACEHOLDER_URL = /smoke|placeholder|123456|999999|example\.com|test-job/i;

initDb();
seedJobApplicantToolsIfMissing();

const profileSvc = createJobSearchProfileService(getDb);
const jobsSvc = createJobApplicationsService(getDb);

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

async function req(method, path, body = null, headers = {}) {
  const url = `${BASE.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${data?.error || res.statusText}`);
  return data;
}

function setupProfile() {
  const existing = profileSvc.getProfile(CEO, PROFILE);
  if (existing.status === 'none') {
    profileSvc.createProfile(CEO, {
      profile_id: PROFILE,
      display_name: 'Banking SVP — Technology & Cloud (Singapore)',
    });
  }

  const saved = profileSvc.savePatch(CEO, PROFILE, {
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
    master_resume_path: RESUME_PATH,
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

  assert(saved.intake_complete, 'Profile intake complete');
  profileSvc.confirm(CEO, PROFILE, true);
  profileSvc.setActiveProfile(CEO, PROFILE);
  assert(profileSvc.getActiveProfileId(CEO) === PROFILE, 'Profile active and set as default');

  const paths = getSpreadsheetPaths(CEO, PROFILE);
  console.log('  Local tracker dir:', paths.dir);
  console.log('  Resume path:', RESUME_PATH);
}

async function warmupBrowser() {
  const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || GATEWAY).replace(/\/$/, '');
  const token =
    process.env.OPENCLAW_GATEWAY_TOKEN ||
    JSON.parse(readFileSync(join(process.env.USERPROFILE, '.openclaw', 'openclaw.json'), 'utf8'))?.gateway?.auth
      ?.token ||
    '';
  const res = await fetch(`${gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-openclaw-agent-id': 'jobdiscovery',
    },
    body: JSON.stringify({ tool: 'browser', args: { action: 'start', profile: 'openclaw' } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Browser warmup failed: ${await res.text()}`);
  console.log('  Browser warmed up (profile=openclaw)');
}

async function runDiscoveryAgent() {
  const message = `[ceo_user_id: ${CEO}]
Run REAL job discovery for profile_id "${PROFILE}" (active — Banking SVP Technology & Cloud, Singapore).

Browser profile=openclaw is already started. Search BOTH sources:
1. LinkedIn Jobs: https://www.linkedin.com/jobs/search/?keywords=SVP%20technology%20banking&location=Singapore
2. JobStreet: https://www.jobstreet.com.sg/jobs?keywords=SVP%20technology%20banking&location=Singapore (if page loads; LinkedIn alone is OK if JobStreet fails)

Steps (all required):
1. job_check_profile_active + job_search_profile_get
2. job_inventory_summary
3. Browser: collect 2–4 REAL executive banking/tech job URLs from LinkedIn (and JobStreet if available)
4. For each: job_check_url_seen → jobs_append with real URLs (no placeholders)
5. job_run_workflow_now with profile_id "${PROFILE}"

Report: companies, job URLs appended, workflow_number, Kanban CEO review task id.`;

  console.log('\n--- Job Discovery agent (browser + tools) ---');
  console.log('Timeout:', CHAT_TIMEOUT_MS / 1000, 's\n');

  process.env.OPENCLAW_FETCH_TIMEOUT_MS = String(CHAT_TIMEOUT_MS);
  const { content: reply } = await openclaw.chatCompletions(
    'jobdiscovery',
    [{ role: 'user', content: message }],
    `discovery-e2e-${Date.now()}`,
    false
  );

  console.log('--- Agent reply (excerpt) ---');
  console.log(String(reply || '').slice(0, 2500));
  if (reply?.length > 2500) console.log('...(truncated)');
  console.log('---\n');
  return { reply };
}

async function main() {
  console.log('\n=== Job Discovery E2E (real browser, no mocks) ===\n');

  assert(existsSync(RESUME_PATH), `Resume exists: ${RESUME_PATH}`);

  console.log('1. Health checks…');
  await req('GET', '/api/health');
  try {
    const gw = await fetch(`${GATEWAY.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) });
    assert(gw.ok, `Gateway reachable (${GATEWAY})`);
  } catch (e) {
    throw new Error(`Gateway not reachable at ${GATEWAY}: ${e.message}`);
  }

  console.log('\n2. Setup profile…');
  setupProfile();

  console.log('\n3. Warm up browser…');
  await warmupBrowser();

  console.log('\n4. Discovery agent run…');
  await runDiscoveryAgent();

  console.log('\n5. Verify results…');
  const jobs = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 50 });
  assert(jobs.length >= 1, `At least 1 job in tracker (found ${jobs.length})`);

  const realJobs = jobs.filter(
    (j) =>
      j.url &&
      (j.url.includes('linkedin.com') || j.url.includes('jobstreet.com')) &&
      !PLACEHOLDER_URL.test(j.url)
  );
  assert(realJobs.length >= 1, `At least 1 real LinkedIn/JobStreet URL (found ${realJobs.length})`);
  for (const j of realJobs.slice(0, 5)) {
    console.log(`     → ${j.company || '?'} | ${j.title || '?'} | ${j.url}`);
  }

  const paths = getSpreadsheetPaths(CEO, PROFILE);
  assert(existsSync(paths.csv_path), `Local tracker CSV: ${paths.csv_path}`);
  assert(existsSync(paths.summary_path), `Local matches summary: ${paths.summary_path}`);
  const csvLines = readFileSync(paths.csv_path, 'utf8').trim().split('\n');
  assert(csvLines.length >= 2, `CSV has data rows (${csvLines.length - 1} jobs)`);

  const summary = readFileSync(paths.summary_path, 'utf8');
  assert(summary.includes(PROFILE), 'Summary references profile_id');
  assert(summary.includes('linkedin.com') || summary.includes(LINKEDIN), 'Summary includes LinkedIn profile');

  const db = getDb();
  const ceoKanban = db
    .prepare(
      `SELECT id, title, status FROM kanban_tasks WHERE description LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%ceo_review_profile:${PROFILE}%`);
  assert(ceoKanban?.id, `CEO review Kanban task #${ceoKanban?.id || '?'}`);
  assert(
    ceoKanban?.status === 'awaiting_confirmation' || ceoKanban?.status === 'completed',
    `Kanban status: ${ceoKanban?.status}`
  );

  const wf = db
    .prepare(
      `SELECT id, workflow_number, status FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(CEO, PROFILE);
  assert(wf?.id, `Workflow run #${wf?.workflow_number} (id ${wf?.id})`);
  assert(['running', 'completed'].includes(wf?.status), `Workflow status: ${wf?.status}`);

  const toolLogs = db
    .prepare(
      `SELECT tool_name, status FROM content_tool_logs WHERE tool_name IN ('jobs_append','job_run_workflow_now','browser') ORDER BY id DESC LIMIT 30`
    )
    .all();
  const appendLog = toolLogs.find((l) => l.tool_name === 'jobs_append' && l.status === 'ok');
  const workflowLog = toolLogs.find((l) => l.tool_name === 'job_run_workflow_now' && l.status === 'ok');
  assert(appendLog, 'jobs_append tool was called successfully');
  assert(workflowLog, 'job_run_workflow_now tool was called successfully');

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);

  console.log('E2E SUCCESS');
  console.log(`Profile: ${PROFILE}`);
  console.log(`Jobs: ${jobs.length} | Real portal URLs: ${realJobs.length}`);
  console.log(`Kanban CEO review: #${ceoKanban.id}`);
  console.log(`Workflow: #${wf.workflow_number}`);
  console.log(`Local files:\n  ${paths.csv_path}\n  ${paths.summary_path}\n`);
}

main().catch((e) => {
  console.error('\nE2E fatal:', e.message || e);
  process.exit(1);
});
