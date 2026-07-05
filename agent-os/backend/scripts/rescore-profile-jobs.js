/**
 * Re-enrich and re-score existing jobs for a profile (e.g. after scoring fixes).
 * Run: node backend/scripts/rescore-profile-jobs.js banking-svp-cloud-sg
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../src/db/schema.js';
import { createJobSearchProfileService } from '../src/services/job-search-profile.js';
import { createJobApplicationsService } from '../src/services/job-applications.js';
import { enrichJobFromUrl } from '../src/services/job-job-enrichment.js';
import { scoreJobForProfile } from '../src/services/job-applicant-fit-score.js';
import { runPhase1SubmitCeoReview } from '../src/services/job-applicant-ceo-review.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}

initDb();

const CEO = process.env.AGENT_OS_CEO_USER_ID || 'default';
const PROFILE = process.argv[2] || 'banking-svp-cloud-sg';

const profileSvc = createJobSearchProfileService(getDb);
const jobsSvc = createJobApplicationsService(getDb);

const profile = profileSvc.getProfile(CEO, PROFILE);
if (!profile?.id) throw new Error(`Profile not found: ${PROFILE}`);

profileSvc.savePatch(CEO, PROFILE, {
  borderline_review: { enabled: true, min_score: 60 },
  discovery_depth: { min_jobs_per_source: 10, linkedin_pages: 3, jobstreet_pages: 3 },
  discovery_min_per_source: 10,
});
if (profile.status !== 'active') {
  profileSvc.confirm(CEO, PROFILE, true);
}

const jobs = jobsSvc.list({ ceo_user_id: CEO, profile_id: PROFILE, limit: 500 });
console.log(`Re-scoring ${jobs.length} jobs for ${PROFILE}...`);

for (const job of jobs) {
  const enriched = enrichJobFromUrl(job);
  if (enriched.title !== job.title || enriched.company !== job.company) {
    jobsSvc.update(job.job_id, {
      title: enriched.title || job.title,
      company: enriched.company || job.company,
      source: enriched.source || job.source,
    });
  }
  jobsSvc.update(job.job_id, { status: 'discovered' });
  const result = await scoreJobForProfile({ profile, job: jobsSvc.get(job.job_id), jobsSvc, updateRow: true });
  console.log(`  ${result.company || '?'} | ${result.title || '?'} → ${result.fit_score}% ${result.status}`);
}

const review = await runPhase1SubmitCeoReview({ ceoUserId: CEO, profileId: PROFILE });
console.log('\nKanban:', review.kanban?.kanban_task_id, '| awaiting:', review.awaiting_approval_count);
console.log('Done.');
