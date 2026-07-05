/**
 * Server-side harvest + validated jobs_append (before LLM discovery delegation).
 */
import { harvestJobListingsForProfile } from './job-portal-harvest.js';
import { enrichJobFromUrl } from './job-job-enrichment.js';
import { validateJobListing } from './job-url-validation.js';
import { assessDiscoveryRun } from './job-discovery-instructions.js';

const SERVER_MIN_JOBS = Number(process.env.JOB_DISCOVERY_SERVER_MIN || 6);

function inferSourceFromListing(listing = {}) {
  const url = listing.url || '';
  if (/linkedin/i.test(url) || listing.source === 'linkedin') return 'linkedin.com';
  if (/jobstreet/i.test(url) || listing.source === 'jobstreet') return 'jobstreet.com.sg';
  return listing.source || '';
}

function listingToJob(listing) {
  const source = inferSourceFromListing(listing);
  const enriched = enrichJobFromUrl({
    url: listing.url,
    title: listing.title || '',
    company: listing.company || '',
    source,
    location: listing.location || '',
    job_description:
      listing.job_description ||
      `Executive technology role: ${listing.title || 'See listing'}. ${listing.company ? `Company: ${listing.company}.` : ''} Source: ${source}.`,
  });
  return enriched;
}

/**
 * Harvest portal search pages and append validated listing URLs.
 */
export async function harvestAndAppendJobs(ceoUserId, profileId, intake, jobsService, opts = {}) {
  const minTarget = opts.min_jobs ?? SERVER_MIN_JOBS;
  const harvest = await harvestJobListingsForProfile(intake, {
    max_listings: opts.max_listings ?? Math.max(minTarget + 4, 20),
    max_pages: opts.max_pages,
    per_source_timeout_ms: opts.per_source_timeout_ms,
    source: opts.source,
    agent_id: opts.agent_id || 'jobdiscovery',
  });

  const toAppend = [];
  const rejected = [];

  for (const listing of harvest.listings || []) {
    const job = listingToJob(listing);
    const check = validateJobListing(job);
    if (!check.ok) {
      rejected.push({ url: listing.url, errors: check.errors });
      continue;
    }
    toAppend.push(check.job);
  }

  let append = { count_added: 0, added: [], skipped_seen: [], count_skipped_seen: 0 };
  if (toAppend.length) {
    append = jobsService.append(toAppend, {
      profile_id: profileId,
      ceo_user_id: ceoUserId,
      skip_if_seen: opts.skip_if_seen !== false,
    });
  }

  const discoveredCount = jobsService.list({
    status: 'discovered',
    profile_id: profileId,
    ceo_user_id: ceoUserId,
    limit: 500,
  }).length;

  const assess = assessDiscoveryRun(intake, discoveredCount);

  return {
    ok: append.count_added > 0 || discoveredCount >= minTarget,
    harvest_count: harvest.count || 0,
    append,
    rejected,
    discovered_count: discoveredCount,
    min_target: minTarget,
    min_required: assess.minRequired,
    meets_quota: discoveredCount >= Math.min(minTarget, assess.minRequired),
    harvest_runs: harvest.runs,
    login_walls: (harvest.runs || []).filter((r) => r.login_wall).map((r) => r.source),
  };
}
