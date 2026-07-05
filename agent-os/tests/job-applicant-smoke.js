/**
 * Smoke test for Job Applicant profile and jobs tools (no server required).
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { seedJobApplicantToolsIfMissing } from '../backend/src/db/seed-job-applicant-tools.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';

initDb();
seedJobApplicantToolsIfMissing();

const profile = createJobSearchProfileService(getDb);
const jobs = createJobApplicationsService(getDb);

const CEO = 'default';
const PROFILE = 'default';

const p0 = profile.getProfile(CEO, PROFILE);
console.log('intake status:', p0.status, 'missing:', p0.missing_fields.length);

profile.savePatch(CEO, PROFILE, {
  locations: ['Singapore', 'Remote APAC'],
  work_mode: 'hybrid',
  target_titles: ['Principal Architect', 'Head of Architecture'],
  sources: ['linkedin', 'jobstreet'],
  master_resume_path: '1_foundations/me/Bala_resume_latest.pdf',
  linkedin_profile: 'https://www.linkedin.com/in/balajimuthukrishnan',
  fit_threshold: 70,
  approval_channel: 'kanban',
  submit_policy: 'fill_and_stop',
  honesty_ack: true,
});

const confirmed = profile.confirm(CEO, PROFILE, true);
console.log('confirmed status:', confirmed.status);

const append = jobs.append(
  [{ url: 'https://example.com/jobs/1', company: 'Test Bank', title: 'Cloud Architect', source: 'linkedin' }],
  { profile_id: PROFILE, ceo_user_id: CEO }
);
console.log('append:', append);

const gate = profile.assertActive(CEO, PROFILE);
console.log('active:', gate.active);

console.log('OK');
