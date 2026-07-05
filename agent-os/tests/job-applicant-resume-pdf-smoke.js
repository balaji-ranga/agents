/**
 * Smoke: master PDF read → tailored resume + cover letter PDFs → awaiting_approval.
 * Run: node tests/job-applicant-resume-pdf-smoke.js
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../backend/src/db/schema.js';
import { initDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService, makeJobId } from '../backend/src/services/job-applications.js';
import { readMasterResumeText, tailorResumeForJob } from '../backend/src/services/job-applicant-resume.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESUME = join(__dirname, '..', '..', '1_foundations', 'me', 'Bala_resume_latest.pdf');

initDb();

const CEO = 'default';
const PROFILE = `pdf-smoke-${Date.now().toString(36)}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const profileSvc = createJobSearchProfileService(() => getDb());
const jobsSvc = createJobApplicationsService(() => getDb());

profileSvc.createProfile(CEO, {
  profile_id: PROFILE,
  display_name: 'PDF Smoke Test',
  patch: {
    locations: ['Singapore'],
    work_mode: 'hybrid',
    target_titles: ['SVP Technology'],
    sources: ['linkedin'],
    master_resume_path: RESUME,
    linkedin_profile: 'https://www.linkedin.com/in/balaji-m/',
    fit_threshold: 70,
    approval_channel: 'kanban',
    workflow_goal: 'job_application',
    submit_policy: 'ceo_confirm_each',
    honesty_ack: true,
    cover_letter_policy: 'full letter',
  },
});
profileSvc.confirm(CEO, PROFILE, true);
profileSvc.setActiveProfile(CEO, PROFILE);

const jobUrl = `https://example.com/job-pdf-smoke-${Date.now()}`;
const jobId = makeJobId(jobUrl, 'Test Bank', 'SVP Cloud', PROFILE);
const appended = jobsSvc.append(
  [
    {
      job_id: jobId,
      url: jobUrl,
      company: 'Test Bank',
      title: 'SVP Cloud Architecture',
      source: 'linkedin',
      location: 'Singapore',
    },
  ],
  { ceo_user_id: CEO, profile_id: PROFILE, skip_if_seen: false }
);
assert(appended.count_added === 1, `Job not added: ${JSON.stringify(appended)}`);
jobsSvc.update(jobId, {
  status: 'shortlisted',
  fit_score: 85,
  fit_rationale: 'Strong cloud and banking leadership fit.',
});

const { masterText } = await readMasterResumeText(profileSvc.getProfile(CEO, PROFILE));
assert(masterText.length > 100, `Master resume text too short: ${masterText.length}`);

const result = await tailorResumeForJob({
  ceoUserId: CEO,
  profileId: PROFILE,
  jobId,
  syncSpreadsheet: false,
});

assert(result.uses_master_resume === true, 'Uses master resume');
assert(existsSync(result.resume_variant_path), 'Master resume path missing');
assert(existsSync(result.cover_letter_path), 'Cover letter PDF missing');
assert(result.material_links?.resume_pdf?.includes('master-resume'), 'Master resume API URL');
assert(result.job.status === 'awaiting_approval', `Expected awaiting_approval, got ${result.job.status}`);

// cleanup — do not leave smoke profile as active CEO profile
jobsSvc.update(jobId, { status: 'skipped' });
const settings = getDb().prepare('SELECT active_profile_id FROM job_search_ceo_settings WHERE ceo_user_id = ?').get(CEO);
if (settings?.active_profile_id === PROFILE) {
  getDb().prepare(`DELETE FROM job_search_ceo_settings WHERE ceo_user_id = ? AND active_profile_id = ?`).run(CEO, PROFILE);
}
getDb().prepare('DELETE FROM job_applications WHERE profile_id = ?').run(PROFILE);
getDb().prepare('DELETE FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?').run(CEO, PROFILE);

console.log('✓ job-applicant-resume-pdf-smoke passed');
console.log('  resume:', result.resume_variant_path);
console.log('  cover:', result.cover_letter_path);
