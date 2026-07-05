/**
 * LinkedIn login E2E: uses saved Playwright session to discover jobs with auth.
 * Prereqs: run `node scripts/openclaw-browser-login.js` first if not logged in.
 * Run: node tests/job-applicant-linkedin-login-e2e.js
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../backend/src/db/schema.js';
import { seedJobApplicantToolsIfMissing } from '../backend/src/db/seed-job-applicant-tools.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { getBrowserAuthStatus } from '../backend/src/services/job-browser-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const BASE = process.env.AGENT_OS_BASE_URL || 'http://127.0.0.1:3001';
const GATEWAY = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const CEO = process.env.AGENT_OS_CEO_USER_ID || 'default';
const PROFILE = process.env.E2E_PROFILE_ID || 'banking-svp-cloud-sg';
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

async function warmupBrowser() {
  const gatewayUrl = GATEWAY.replace(/\/$/, '');
  let token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const cfgPath = join(process.env.USERPROFILE || '', '.openclaw', 'openclaw.json');
  if (!token && existsSync(cfgPath)) {
    token = JSON.parse(readFileSync(cfgPath, 'utf8'))?.gateway?.auth?.token || '';
  }
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
    target_titles: ['SVP Technology', 'Head of Cloud'],
    sources: ['linkedin.com'],
    master_resume_path: RESUME_PATH,
    linkedin_profile: LINKEDIN,
    fit_threshold: 75,
    approval_channel: 'kanban',
    submit_policy: 'fill_and_stop',
    honesty_ack: true,
    workflow_goal: 'job_application',
    workflow_schedule: 'manual',
    browser_session_ok: true,
    linkedin_session_ok: true,
  });
  profileSvc.confirm(CEO, PROFILE, true);
  profileSvc.setActiveProfile(CEO, PROFILE);
}

async function gatewayChat(message, sessionUser) {
  let token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  const cfgPath = join(process.env.USERPROFILE || '', '.openclaw', 'openclaw.json');
  if (!token && existsSync(cfgPath)) {
    token = JSON.parse(readFileSync(cfgPath, 'utf8'))?.gateway?.auth?.token || '';
  }
  const res = await fetch(`${GATEWAY.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': 'jobdiscovery',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model: 'openclaw',
      messages: [{ role: 'user', content: message }],
      user: sessionUser,
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gateway chat ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function runLinkedInLoggedInDiscovery() {
  const message = `[ceo_user_id: ${CEO}]
LinkedIn AUTHENTICATED discovery for ACTIVE profile_id "${PROFILE}".

The CEO has logged into LinkedIn in OpenClaw browser profile=openclaw (saved cookies).

Steps:
1. job_check_profile_active — must be active (not draft)
2. Browser: open https://www.linkedin.com/feed/ — confirm you see logged-in feed (not login page)
3. Browser: search LinkedIn Jobs for "SVP technology banking" in Singapore — paginate 2+ pages
4. Collect 2–4 REAL job URLs with full title, company, job_description from detail pages
5. job_check_url_seen → jobs_append for each (LinkedIn source only)
6. Do NOT call job_run_workflow_now

If you hit a login wall, report "LOGIN_REQUIRED" clearly.`;

  return gatewayChat(message, `linkedin-login-e2e-${Date.now()}`);
}

async function main() {
  console.log('\n=== LinkedIn login discovery E2E ===\n');

  const authRes = await fetch(`${BASE}/api/job-applicant/browser-auth/status`, { signal: AbortSignal.timeout(8000) });
  const authApi = authRes.ok ? await authRes.json() : {};
  const auth = { ...getBrowserAuthStatus(), ...authApi };

  console.log('Browser auth:', {
    storage_state_exists: auth.storage_state_exists,
    linkedin_logged_in: auth.linkedin_logged_in,
  });

  const hasSession = auth.storage_state_exists && auth.linkedin_logged_in;
  if (!hasSession) {
    console.warn('\n⚠ LinkedIn login not detected. Run: node scripts/openclaw-browser-login.js\n');
  }
  assert(hasSession, 'LinkedIn login session required (node scripts/openclaw-browser-login.js)');

  await fetch(`${BASE}/api/job-applicant/browser-auth/warmup`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
  }).catch(() => null);

  const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
  assert(health.ok, 'Backend health');
  const gw = await fetch(`${GATEWAY.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) });
  assert(gw.ok, 'Gateway health');

  setupProfile();
  await warmupBrowser();

  const beforeJobs = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 200 });
  const beforeUrls = new Set(beforeJobs.map((j) => j.url));
  const reply = await runLinkedInLoggedInDiscovery();
  console.log('--- Agent reply (excerpt) ---');
  console.log(String(reply || '').slice(0, 2500));
  console.log('---\n');

  assert(!/LOGIN_REQUIRED/i.test(String(reply || '')), 'Agent did not hit LinkedIn login wall');
  assert(
    !/browser control service is not responding|couldn't access the LinkedIn browser/i.test(String(reply || '')),
    'LinkedIn browser responded'
  );

  const jobs = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 200 });
  const newJobs = jobs.filter((j) => j.url && !beforeUrls.has(j.url));
  const linkedinWithMeta = jobs.filter(
    (j) => j.url?.includes('linkedin.com') && j.title?.trim() && j.company?.trim()
  );
  assert(newJobs.length >= 1 || /linkedin\.com\/jobs\/view/i.test(String(reply || '')), `New jobs or LinkedIn URLs in reply (new: ${newJobs.length})`);

  for (const j of linkedinWithMeta.slice(0, 3)) {
    console.log(`     → ${j.company} | ${j.title} | ${j.url}`);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
  console.log('LINKEDIN LOGIN E2E SUCCESS');
}

main().catch((e) => {
  console.error('\nFatal:', e.message || e);
  process.exit(1);
});
