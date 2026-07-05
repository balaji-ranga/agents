/**
 * Job inventory: URL normalization, seen-check, cross-profile dedupe for discovery.
 */
import { VALID_STATUSES } from './job-applications.js';

/** Do not re-suggest to CEO / do not re-append. */
export const BLOCK_REDISCOVERY_STATUSES = new Set([
  'applied',
  'acknowledged',
  'skipped',
  'failed',
  'awaiting_approval',
  'approved',
]);

/** Already tracked — skip append but softer message than applied. */
export const IN_PIPELINE_STATUSES = new Set([
  'discovered',
  'scored',
  'shortlisted',
  'borderline',
  'resume_ready',
  ...BLOCK_REDISCOVERY_STATUSES,
]);

export function normalizeJobUrl(url) {
  if (!url) return '';
  const raw = String(url).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .split('?')[0]
      .split('#')[0];
  }
}

function normalizeCompanyTitle(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function classifySeenStatus(status) {
  if (BLOCK_REDISCOVERY_STATUSES.has(status)) {
    return {
      block_rediscovery: true,
      category: status === 'applied' ? 'applied' : status === 'skipped' ? 'skipped' : 'in_review_or_done',
      message:
        status === 'applied'
          ? 'Already applied — do not suggest again.'
          : status === 'acknowledged'
            ? 'Already acknowledged in scoring summary — do not suggest again.'
            : status === 'skipped'
            ? 'Previously skipped — do not suggest again.'
            : status === 'failed'
              ? 'Previous application failed — review before retry.'
              : status === 'awaiting_approval'
                ? 'Already in CEO Kanban review — do not suggest again.'
                : status === 'approved'
                  ? 'Already approved for application — do not suggest again.'
                  : 'Already in pipeline — do not suggest again.',
    };
  }
  if (IN_PIPELINE_STATUSES.has(status)) {
    return {
      block_rediscovery: true,
      category: 'in_pipeline',
      message: `Already tracked (${status}) — do not duplicate.`,
    };
  }
  return { block_rediscovery: false, category: 'unknown', message: '' };
}

export function createJobInventoryHelpers(getDb, jobsService) {
  function rowsForCeo(ceoUserId, profileId = null) {
    const db = getDb();
    if (profileId) {
      return db
        .prepare(`SELECT * FROM job_applications WHERE ceo_user_id = ? AND profile_id = ? ORDER BY updated_at DESC`)
        .all(ceoUserId, profileId);
    }
    return db
      .prepare(`SELECT * FROM job_applications WHERE ceo_user_id = ? ORDER BY updated_at DESC LIMIT 2000`)
      .all(ceoUserId);
  }

  function findByNormalizedUrl(ceoUserId, url, { crossProfile = true, profileId = null } = {}) {
    const norm = normalizeJobUrl(url);
    if (!norm) return [];
    const rows = rowsForCeo(ceoUserId, crossProfile ? null : profileId);
    return rows.filter((row) => normalizeJobUrl(row.url) === norm);
  }

  function findByIdentity(ceoUserId, profileId, { url, company, title, jobId }) {
    const db = getDb();
    if (jobId) {
      const row = db.prepare('SELECT * FROM job_applications WHERE job_id = ?').get(jobId);
      return row ? [row] : [];
    }
    const normUrl = normalizeJobUrl(url);
    const normCo = normalizeCompanyTitle(company);
    const normTitle = normalizeCompanyTitle(title);
    const rows = rowsForCeo(ceoUserId, profileId);
    return rows.filter((row) => {
      if (normUrl && normalizeJobUrl(row.url) === normUrl) return true;
      if (normCo && normTitle && normalizeCompanyTitle(row.company) === normCo && normalizeCompanyTitle(row.title) === normTitle) {
        return true;
      }
      return false;
    });
  }

  function checkJobSeen(ceoUserId, profileId, { url, company, title, job_id, cross_profile = true } = {}) {
    const matches = [];
    const byProfile = findByIdentity(ceoUserId, profileId, { url, company, title, jobId: job_id });
    for (const row of byProfile) matches.push({ ...row, match_type: 'profile' });

    if (cross_profile && url) {
      for (const row of findByNormalizedUrl(ceoUserId, url, { crossProfile: true })) {
        if (!matches.some((m) => m.job_id === row.job_id)) {
          matches.push({ ...row, match_type: 'cross_profile_url' });
        }
      }
    }

    if (matches.length === 0) {
      return {
        seen: false,
        block_rediscovery: false,
        ceo_user_id: ceoUserId,
        profile_id: profileId,
        normalized_url: normalizeJobUrl(url),
      };
    }

    const priority = ['applied', 'acknowledged', 'approved', 'awaiting_approval', 'failed', 'skipped', 'shortlisted', 'discovered'];
    matches.sort((a, b) => {
      const ai = priority.indexOf(a.status);
      const bi = priority.indexOf(b.status);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    const best = matches[0];
    const classification = classifySeenStatus(best.status);

    return {
      seen: true,
      block_rediscovery: classification.block_rediscovery,
      category: classification.category,
      message: classification.message,
      match_type: best.match_type,
      existing_job: {
        job_id: best.job_id,
        profile_id: best.profile_id,
        status: best.status,
        company: best.company,
        title: best.title,
        url: best.url,
        updated_at: best.updated_at,
      },
      all_matches: matches.slice(0, 5).map((m) => ({
        job_id: m.job_id,
        profile_id: m.profile_id,
        status: m.status,
        match_type: m.match_type,
      })),
      ceo_user_id: ceoUserId,
      profile_id: profileId,
      normalized_url: normalizeJobUrl(url),
    };
  }

  function inventorySummary(ceoUserId, profileId = null) {
    const rows = rowsForCeo(ceoUserId, profileId);
    const byStatus = {};
    for (const s of VALID_STATUSES) byStatus[s] = 0;
    const blockUrls = new Set();
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      if (BLOCK_REDISCOVERY_STATUSES.has(row.status) || IN_PIPELINE_STATUSES.has(row.status)) {
        const nu = normalizeJobUrl(row.url);
        if (nu) blockUrls.add(nu);
      }
    }
    return {
      ceo_user_id: ceoUserId,
      profile_id: profileId,
      total: rows.length,
      count_by_status: byStatus,
      do_not_rediscover_count: blockUrls.size,
      normalized_urls_to_skip: [...blockUrls].slice(0, 200),
      recent_applied: rows
        .filter((r) => r.status === 'applied')
        .slice(0, 20)
        .map((r) => ({ job_id: r.job_id, company: r.company, title: r.title, url: r.url, profile_id: r.profile_id })),
      hint: 'Call job_check_url_seen before jobs_append. Use jobs_list with status applied/skipped for full history.',
    };
  }

  return { checkJobSeen, inventorySummary, normalizeJobUrl, findByNormalizedUrl };
}
