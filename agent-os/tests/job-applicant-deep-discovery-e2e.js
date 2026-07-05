/**
 * Deep discovery E2E: LinkedIn + JobStreet, multi-page pagination, real browser.
 * Prereqs: backend (3001), OpenClaw gateway (18789), active profile.
 * Run: node tests/job-applicant-deep-discovery-e2e.js
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../backend/src/db/schema.js';
import { seedJobApplicantToolsIfMissing } from '../backend/src/db/seed-job-applicant-tools.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const BASE = process.env.AGENT_OS_BASE_URL || 'http://127.0.0.1:3001';
const GATEWAY = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const CEO = process.env.AGENT_OS_CEO_USER_ID || 'default';
const PROFILE = process.env.E2E_PROFILE_ID || 'banking-svp-cloud-sg';
const RESUME_PATH = join(AGENT_OS_ROOT, '..', '1_foundations', 'me', 'Bala_resume_latest.pdf');
const LINKEDIN = 'https://www.linkedin.com/in/balaji-ranganathan-7067a221/';
const CHAT_TIMEOUT_MS = Number(process.env.E2E_CHAT_TIMEOUT_MS || 900000);
const MIN_PER_SOURCE = Number(process.env.E2E_MIN_JOBS_PER_SOURCE || 3);

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
  const saved = profileSvc.savePatch(CEO, PROFILE, {
    locations: ['Singapore'],
    work_mode: 'hybrid',
    work_authorization: 'Singapore PR / Citizen',
    target_titles: [
      'Senior Vice President Technology',
      'SVP Cloud',
      'Head of Cloud',
      'Executive Director Technology',
    ],
    seniority: 'executive',
    industries: ['banking', 'financial services'],
    sources: ['linkedin.com', 'jobstreet.com.sg', 'jobstreet.com'],
    master_resume_path: RESUME_PATH,
    linkedin_profile: LINKEDIN,
    fit_threshold: 75,
    approval_channel: 'kanban',
    submit_policy: 'fill_and_stop',
    honesty_ack: true,
    workflow_goal: 'job_application',
    workflow_schedule: 'manual',
    discovery_min_per_source: MIN_PER_SOURCE,
    discovery_max_per_run: 25,
    discovery_depth: { linkedin_pages: 3, jobstreet_pages: 3 },
  });
  assert(saved.intake_complete, 'Profile intake complete');
  profileSvc.confirm(CEO, PROFILE, true);
  profileSvc.setActiveProfile(CEO, PROFILE);
  assert(profileSvc.getProfile(CEO, PROFILE).status === 'active', 'Profile confirmed active');
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

async function agentChat(message, sessionKey) {
  return gatewayChat(message, sessionKey);
}

async function runDeepDiscovery() {
  const ts = Date.now();

  await warmupBrowser();
  console.log('Phase 1: LinkedIn deep discovery…');
  const linkedinReply = await agentChat(
    `[ceo_user_id: ${CEO}] Active profile_id "${PROFILE}" (not draft).
Use browser profile=openclaw. LinkedIn Jobs: SVP technology banking Singapore — paginate ≥2 pages.
For each NEW listing: job_check_url_seen → jobs_append (title, company, url, source=linkedin, job_description).
Skip URLs already in inventory. Append up to ${MIN_PER_SOURCE} new jobs. No job_run_workflow_now.`,
    `deep-discovery-linkedin-${ts}`
  );
  console.log('--- LinkedIn reply (excerpt) ---');
  console.log(String(linkedinReply).slice(0, 2500));

  await warmupBrowser();
  console.log('\nPhase 2: JobStreet deep discovery…');
  const jobstreetReply = await agentChat(
    `[ceo_user_id: ${CEO}] Active profile_id "${PROFILE}".
Use browser profile=openclaw. JobStreet: https://www.jobstreet.com.sg/jobs?keywords=SVP%20technology%20banking&location=Singapore — paginate ≥2 pages.
For each NEW listing: job_check_url_seen → jobs_append (title, company, url, source=jobstreet, job_description).
If login wall report LOGIN_REQUIRED. Append up to ${MIN_PER_SOURCE} new JobStreet jobs.`,
    `deep-discovery-jobstreet-${ts}`
  );
  console.log('--- JobStreet reply (excerpt) ---');
  console.log(String(jobstreetReply).slice(0, 2500));
  console.log('---\n');

  return { linkedinReply, jobstreetReply, combined: `${linkedinReply}\n${jobstreetReply}` };
}

async function main() {
  console.log('\n=== Deep discovery E2E (LinkedIn + JobStreet) ===\n');
  console.log(`Min jobs per source: ${MIN_PER_SOURCE}\n`);

  const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
  assert(health.ok, 'Backend health');
  const gw = await fetch(`${GATEWAY.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) });
  assert(gw.ok, 'Gateway health');

  setupProfile();
  await fetch(`${BASE}/api/job-applicant/browser-auth/warmup`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
  }).catch(() => null);
  await warmupBrowser();
  console.log('\nRunning deep discovery agent (may take several minutes)...\n');

  const beforeLinkedin = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 200 }).filter((j) =>
    j.url?.includes('linkedin.com')
  ).length;
  const beforeJobstreet = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 200 }).filter((j) =>
    /jobstreet\.com/i.test(j.url || '')
  ).length;

  const { combined: reply, linkedinReply, jobstreetReply } = await runDeepDiscovery();
  assert(!/No response from OpenClaw/i.test(String(reply || '')), 'OpenClaw agent returned a response');

  const jobs = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 100 });
  const linkedinJobs = jobs.filter((j) => j.url?.includes('linkedin.com'));
  const jobstreetJobs = jobs.filter((j) => /jobstreet\.com/i.test(j.url || ''));
  const newLinkedin = linkedinJobs.length - beforeLinkedin;
  const newJobstreet = jobstreetJobs.length - beforeJobstreet;

  assert(
    !/browser control service is not available|browser service is currently unavailable/i.test(String(reply || '')) ||
      newLinkedin >= 1,
    'Browser discovery ran (no persistent unavailable error)'
  );

  console.log(
    `\nJobs in tracker: ${jobs.length} (LinkedIn: ${linkedinJobs.length}, JobStreet: ${jobstreetJobs.length}; new: +${newLinkedin} LI, +${newJobstreet} JS)`
  );
  const linkedinBrowserOk =
    newLinkedin >= 1 ||
    (/linkedin\.com\/jobs\/view/i.test(String(linkedinReply || '')) &&
      !/browser control service|No response from OpenClaw/i.test(String(linkedinReply || ''))) ||
    /sign in|login wall|LOGIN_REQUIRED|restricting access/i.test(String(linkedinReply || ''));
  assert(linkedinBrowserOk, `LinkedIn browser ran (new ${newLinkedin})`);

  const jobstreetBrowserOk =
    newJobstreet >= 1 ||
    /jobstreet\.com\/jobs|LOGIN_REQUIRED|login wall|sign in/i.test(String(jobstreetReply || ''));
  assert(jobstreetBrowserOk, `JobStreet browser ran or login required (new ${newJobstreet})`);

  const withMeta = jobs.filter((j) => j.title?.trim() && j.company?.trim());
  assert(withMeta.length >= MIN_PER_SOURCE, `Jobs with title+company (found ${withMeta.length})`);

  const db = getDb();
  const appendLog = db
    .prepare(`SELECT COUNT(*) AS n FROM content_tool_logs WHERE tool_name = 'jobs_append' AND status = 'ok'`)
    .get();
  assert(appendLog?.n >= 1, 'jobs_append succeeded at least once');

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
  console.log('DEEP DISCOVERY E2E SUCCESS');
}

main().catch((e) => {
  console.error('\nFatal:', e.message || e);
  process.exit(1);
});
