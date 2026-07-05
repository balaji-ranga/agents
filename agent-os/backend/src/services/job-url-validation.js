/**
 * Reject search-page URLs and incomplete rows at jobs_append time.
 */
import { enrichJobFromUrl } from './job-job-enrichment.js';

const GENERIC_COMPANIES = new Set(['linkedin', 'jobstreet', 'unknown', 'n/a', 'indeed', 'glassdoor']);

export function isJobSearchPageUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return false;
  return (
    /linkedin\.com\/jobs\/search/.test(u) ||
    /linkedin\.com\/jobs\/collections/.test(u) ||
    /jobstreet\.com(?:\.sg)?\/jobs(\/|\?|$)/.test(u) ||
    /jobstreet\.com(?:\.sg)?\/[^/]+-jobs\/in-/.test(u) ||
    /\/jobs\?keywords=/.test(u)
  );
}

export function isJobListingUrl(url) {
  const u = String(url || '').trim();
  if (!u || isJobSearchPageUrl(u)) return false;
  return (
    /linkedin\.com\/jobs\/view\/[^/?#]+/i.test(u) ||
    /jobstreet\.com(?:\.sg)?\/job\/[^/?#]+/i.test(u) ||
    /jobstreet\.com(?:\.sg)?\/[^/]+\/job\/[^/?#]+/i.test(u)
  );
}

export function validateJobListing(job = {}) {
  const enriched = enrichJobFromUrl(job);
  const errors = [];
  const url = (enriched.url || '').trim();
  const title = (enriched.title || '').trim();
  const company = (enriched.company || '').trim();
  const companyKey = company.toLowerCase();

  if (!url) errors.push('url required');
  else if (isJobSearchPageUrl(url)) errors.push('search page URL not allowed — use individual job listing URL');
  else if (!isJobListingUrl(url)) errors.push('URL must be a LinkedIn /jobs/view/ or JobStreet /job/ listing');

  if (!title || title.length < 3) errors.push('title required (min 3 characters)');
  if (!company || company.length < 2) errors.push('company required');
  if (GENERIC_COMPANIES.has(companyKey)) errors.push('company cannot be a portal name');

  return { ok: errors.length === 0, errors, job: enriched };
}
