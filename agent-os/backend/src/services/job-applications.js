/**
 * Job applications store (Phase 0 local DB; Google Sheets sync in Phase 1).
 */
import { createHash } from 'crypto';
import { createJobInventoryHelpers } from './job-applicant-inventory.js';
import { validateJobListing } from './job-url-validation.js';

const VALID_STATUSES = new Set([
  'discovered',
  'scored',
  'shortlisted',
  'borderline',
  'resume_ready',
  'awaiting_approval',
  'approved',
  'acknowledged',
  'applied',
  'skipped',
  'failed',
  'needs_input',
]);

export function makeJobId(url, company, title, profileId = '') {
  const raw = `${(profileId || '').trim()}|${(url || '').trim().toLowerCase()}|${(company || '').trim().toLowerCase()}|${(title || '').trim().toLowerCase()}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function bindFieldValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function rowToJob(row) {
  if (!row) return null;
  let extra = {};
  try {
    extra = JSON.parse(row.extra_json || '{}');
  } catch (_) {}
  return {
    job_id: row.job_id,
    profile_id: row.profile_id,
    ceo_user_id: row.ceo_user_id,
    status: row.status,
    source: row.source,
    company: row.company,
    title: row.title,
    location: row.location,
    url: row.url,
    fit_score: row.fit_score,
    fit_rationale: row.fit_rationale,
    why_me_summary: row.why_me_summary,
    cover_letter_text: row.cover_letter_text,
    tailoring_notes: row.tailoring_notes,
    owner_action: row.owner_action,
    application_notes: row.application_notes,
    discovered_at: row.discovered_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

export function createJobApplicationsService(getDb) {
  const inventory = createJobInventoryHelpers(getDb, null);

  const service = {
    list({ status, owner_action, profile_id, ceo_user_id, limit = 100 } = {}) {
      const db = getDb();
      let sql = 'SELECT * FROM job_applications WHERE 1=1';
      const params = [];
      if (ceo_user_id) {
        sql += ' AND (ceo_user_id = ? OR ceo_user_id IS NULL)';
        params.push(ceo_user_id);
      }
      if (profile_id) {
        sql += ' AND (profile_id = ? OR profile_id IS NULL)';
        params.push(profile_id);
      }
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }
      if (owner_action) {
        sql += ' AND owner_action = ?';
        params.push(owner_action);
      }
      sql += ' ORDER BY discovered_at DESC LIMIT ?';
      params.push(Math.min(Number(limit) || 100, 500));
      return db.prepare(sql).all(...params).map(rowToJob);
    },

    get(jobId) {
      const db = getDb();
      return rowToJob(db.prepare('SELECT * FROM job_applications WHERE job_id = ?').get(jobId));
    },

    checkJobSeen(ceoUserId, profileId, opts = {}) {
      return inventory.checkJobSeen(ceoUserId, profileId, opts);
    },

    inventorySummary(ceoUserId, profileId = null) {
      return inventory.inventorySummary(ceoUserId, profileId);
    },

    append(jobs = [], { profile_id, ceo_user_id, skip_if_seen = true, cross_profile = true } = {}) {
      if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('jobs array required');
      const db = getDb();
      const ins = db.prepare(
        `INSERT OR IGNORE INTO job_applications (job_id, profile_id, ceo_user_id, status, source, company, title, location, url, extra_json, discovered_at, updated_at)
         VALUES (?, ?, ?, 'discovered', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      );
      const added = [];
      const skipped = [];
      const skipped_seen = [];
      const rejected_invalid = [];
      for (const raw of jobs) {
        const check = validateJobListing(raw);
        if (!check.ok) {
          rejected_invalid.push({
            url: raw?.url,
            title: raw?.title,
            company: raw?.company,
            errors: check.errors,
          });
          continue;
        }
        const j = check.job;
        const url = (j.url || '').trim();
        const company = (j.company || '').trim();
        const title = (j.title || '').trim();
        if (!url && !title) continue;
        const pid = j.profile_id || profile_id || null;
        const ceo = j.ceo_user_id || ceo_user_id || null;

        if (skip_if_seen && ceo && pid) {
          const seen = inventory.checkJobSeen(ceo, pid, {
            url,
            company,
            title,
            job_id: j.job_id,
            cross_profile,
          });
          if (seen.seen && seen.block_rediscovery) {
            skipped_seen.push({
              url,
              company,
              title,
              reason: seen.message,
              category: seen.category,
              existing_job: seen.existing_job,
              match_type: seen.match_type,
            });
            continue;
          }
        }

        const jobId = j.job_id || makeJobId(url, company, title, pid || '');
        const extra = { ...(j.extra || {}), normalized_url: inventory.normalizeJobUrl(url) };
        delete extra.job_id;
        const result = ins.run(
          jobId,
          pid,
          ceo,
          (j.source || '').trim() || null,
          company || null,
          title || null,
          (j.location || '').trim() || null,
          url || null,
          Object.keys(extra).length ? JSON.stringify(extra) : null
        );
        if (result.changes > 0) added.push(jobId);
        else {
          skipped.push(jobId);
          const existing = db.prepare('SELECT job_id, status, profile_id FROM job_applications WHERE job_id = ?').get(jobId);
          if (existing) {
            skipped_seen.push({
              url,
              company,
              title,
              reason: `Exact job_id already exists (${existing.status})`,
              category: 'duplicate_id',
              existing_job: existing,
              match_type: 'job_id',
            });
          }
        }
      }
      return {
        added,
        skipped,
        skipped_seen,
        rejected_invalid,
        count_added: added.length,
        count_skipped_seen: skipped_seen.length,
        count_rejected_invalid: rejected_invalid.length,
      };
    },

    update(jobId, patch = {}) {
      if (!jobId) throw new Error('job_id required');
      const db = getDb();
      const existing = db.prepare('SELECT * FROM job_applications WHERE job_id = ?').get(jobId);
      if (!existing) throw new Error('Job not found');

      const allowed = [
        'status',
        'source',
        'company',
        'title',
        'location',
        'url',
        'fit_score',
        'fit_rationale',
        'why_me_summary',
        'cover_letter_text',
        'tailoring_notes',
        'owner_action',
        'application_notes',
      ];
      const updates = [];
      const values = [];
      for (const key of allowed) {
        if (patch[key] !== undefined) {
          if (key === 'status' && !VALID_STATUSES.has(patch[key])) {
            throw new Error(`Invalid status: ${patch[key]}`);
          }
          updates.push(`${key} = ?`);
          values.push(bindFieldValue(patch[key]));
        }
      }
      const extraPatch = patch.extra && typeof patch.extra === 'object' ? patch.extra : {};
      if (Object.keys(extraPatch).length > 0) {
        let extra = {};
        try {
          extra = JSON.parse(existing.extra_json || '{}');
        } catch (_) {}
        const mergedExtra = { ...extra, ...extraPatch };
        updates.push('extra_json = ?');
        values.push(JSON.stringify(mergedExtra));
      }
      if (updates.length === 0) throw new Error('No valid patch fields');
      updates.push("updated_at = datetime('now')");
      values.push(jobId);
      db.prepare(`UPDATE job_applications SET ${updates.join(', ')} WHERE job_id = ?`).run(...values);
      return this.get(jobId);
    },
  };

  return service;
}

export { VALID_STATUSES };

