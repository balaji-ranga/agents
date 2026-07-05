/**
 * Smoke: job inventory seen-check + cross-profile URL dedupe on append.
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobApplicationsService } from '../backend/src/services/job-applications.js';
import { normalizeJobUrl } from '../backend/src/services/job-applicant-inventory.js';

initDb();

const jobs = createJobApplicationsService(getDb);
const CEO = `inv-smoke-${Date.now()}`;
const P1 = `profile-a-${Date.now()}`;
const P2 = `profile-b-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('✓', msg);
}

const url = 'https://www.jobstreet.com.sg/job/head-of-eng-dbs-999';
const urlVariant = 'https://jobstreet.com.sg/job/head-of-eng-dbs-999/';

assert(normalizeJobUrl(url) === normalizeJobUrl(urlVariant), 'URL normalization matches variants');

const first = jobs.append(
  [{ source: 'jobstreet.com', company: 'DBS', title: 'Head of Engineering', url, location: 'SG' }],
  { profile_id: P1, ceo_user_id: CEO }
);
assert(first.count_added === 1, 'First append adds job');

jobs.update(first.added[0], { status: 'applied' });

const seen = jobs.checkJobSeen(CEO, P2, { url: urlVariant, company: 'DBS', title: 'Head of Engineering', cross_profile: true });
assert(seen.seen && seen.block_rediscovery, 'Cross-profile sees applied job');
assert(seen.existing_job.status === 'applied', 'Reports applied status');
assert(seen.match_type === 'cross_profile_url', 'Cross-profile URL match');

const blocked = jobs.append(
  [{ source: 'jobstreet.com', company: 'DBS', title: 'Head of Engineering', url: urlVariant, location: 'SG' }],
  { profile_id: P2, ceo_user_id: CEO, skip_if_seen: true, cross_profile: true }
);
assert(blocked.count_added === 0, 'Append blocked on profile B');
assert(blocked.count_skipped_seen === 1, 'skipped_seen reported');
assert(blocked.skipped_seen[0].category === 'applied', 'Category applied');

const newUrl = 'https://www.jobstreet.com.sg/job/brand-new-role-888';
const allowed = jobs.append(
  [{ source: 'jobstreet.com', company: 'NewCo', title: 'Director', url: newUrl }],
  { profile_id: P2, ceo_user_id: CEO }
);
assert(allowed.count_added === 1, 'New URL still appends');

const summary = jobs.inventorySummary(CEO, P1);
assert(summary.count_by_status.applied >= 1, 'Summary counts applied');
assert(summary.do_not_rediscover_count >= 1, 'Summary tracks URLs to skip');

console.log('\nOK — job inventory smoke passed\n');
