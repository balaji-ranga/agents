/**
 * Discovery stage prompts, quotas, and completion checks.
 */
import { parseDiscoveryDepth } from './job-candidate-context.js';

export const DISCOVERY_RETRY_MAX = 3;

export function countProfileSources(intake = {}) {
  const s = intake.sources;
  if (Array.isArray(s)) return Math.max(1, s.filter(Boolean).length);
  const parts = String(s || 'linkedin,jobstreet')
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return Math.max(1, parts.length);
}

export function parseDiscoveryRetry(text = '') {
  const re = /\[discovery_retry:(\d+)\/(\d+)\]/g;
  let last = null;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    last = { current: Number(m[1]), max: Number(m[2]) };
  }
  return last || { current: 0, max: DISCOVERY_RETRY_MAX };
}

export function discoveryLooksExhausted(responseText = '') {
  const t = String(responseText).toLowerCase();
  return /(?:inventory|results?|listings?) exhaust|no more (?:pages?|results?|listings?|jobs)|login required|login wall|zero listings|portal blocked|could not find any jobs|all urls (?:already )?seen|blocked you/.test(
    t
  );
}

export function assessDiscoveryRun(intake = {}, discoveredCount, responseText = '') {
  const depth = parseDiscoveryDepth(intake);
  const sourceCount = countProfileSources(intake);
  const minRequired = Math.min(depth.max_jobs_per_run, depth.min_jobs_per_source * sourceCount);
  if (discoveredCount >= minRequired) {
    return { ok: true, discoveredCount, minRequired, depth, exhausted: false };
  }
  if (discoveryLooksExhausted(responseText)) {
    return { ok: true, discoveredCount, minRequired, depth, exhausted: true };
  }
  return { ok: false, discoveredCount, minRequired, depth, exhausted: false };
}

export function buildDiscoveryPaginationBlock(intake = {}) {
  const depth = parseDiscoveryDepth(intake);
  const sourceCount = countProfileSources(intake);
  const minRequired = Math.min(depth.max_jobs_per_run, depth.min_jobs_per_source * sourceCount);

  return `Discovery quotas (from profile — do NOT stop after the first screen):
- Minimum NEW jobs this run: ${depth.min_jobs_per_source} per source (${sourceCount} source(s) → aim for ≥${minRequired} total via jobs_append)
- Maximum this run: ${depth.max_jobs_per_run}
- LinkedIn result pages to paginate: ${depth.linkedin_pages}
- JobStreet result pages to paginate: ${depth.jobstreet_pages}

Tool policy:
- **Do NOT call browser action=start** — the backend manages Playwright for harvest.
- **FIRST:** call **job_portal_harvest_listings** — opens profile search URLs (LinkedIn + JobStreet), scrolls, returns job listing URLs.
- Use **browser open** only for individual job detail pages if you need job_description (optional).
- Do NOT use summarize_url for LinkedIn/JobStreet discovery.

Two-phase workflow (required):

**Phase A — Harvest (automated)**
1. job_check_profile_active + job_search_profile_get
2. job_inventory_summary
3. **job_portal_harvest_listings** with profile_id (optional source: linkedin or jobstreet per call)
4. job_check_url_seen on returned listings

**Phase B — Enrich and append (batches of 5)**
For each NEW listing URL where block_rediscovery is false:
1. browser open detail URL → snapshot
2. Extract title, company, location, url, source, job_description (use harvest title as fallback)
3. jobs_append in batches of 5

Repeat Phase A with source=jobstreet if profile has both sources.
Stop when ≥${minRequired} new jobs appended OR harvest returns zero new URLs.`;
}
