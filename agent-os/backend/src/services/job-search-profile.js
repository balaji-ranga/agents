/**
 * Job search profiles: multi-profile per CEO user.
 */
import { slugifyProfileId } from './job-applicant-ceo.js';
import { normalizeDiscoverySchedule, scheduleLabel } from './job-applicant-schedule.js';
import { normalizeLinkedInUrl } from './job-applicant-intake-normalize.js';
import { normalizeWorkflowGoal, workflowGoalFromIntake, workflowGoalLabel } from './job-applicant-workflow-goal.js';

/** Profile lifecycle: draft → active ↔ inactive (deactivated). */
export const PROFILE_STATUSES = ['draft', 'active', 'inactive'];

/** Fields the Job Discovery agent collects during intake. */
export const INTAKE_FIELD_KEYS = [
  'locations',
  'work_mode',
  'work_authorization',
  'target_titles',
  'seniority',
  'industries',
  'excluded_industries',
  'priority_companies',
  'blacklist_companies',
  'discovery_rate',
  'apply_rate_cap',
  'sources',
  'portal_search_patterns',
  'accounts',
  'browser_session_ok',
  'recruiter_outreach',
  'master_resume_path',
  'linkedin_profile',
  'resume_formats',
  'fit_threshold',
  'borderline_review',
  'candidate_summary',
  'profile_summary_path',
  'discovery_min_per_source',
  'discovery_max_per_run',
  'discovery_depth',
  'portal_auth',
  'browser_session_ok',
  'linkedin_session_ok',
  'jobstreet_session_ok',
  'qa_bank',
  'no_auto_fill_fields',
  'approval_channel',
  'workflow_goal',
  'apply_platforms',
  'ambiguous_form_policy',
  'cover_letter_policy',
  'google_sheet_id',
  'gdrive_root_folder',
  'gdrive_layout',
  'discovery_schedule',
  'workflow_schedule',
  'notification_preferences',
  'submit_policy',
  'tailoring_rules',
  'honesty_ack',
];

export const REQUIRED_FOR_ACTIVE = [
  'locations',
  'work_mode',
  'target_titles',
  'sources',
  'master_resume_path',
  'linkedin_profile',
  'fit_threshold',
  'approval_channel',
  'workflow_goal',
  'submit_policy',
  'honesty_ack',
];

function emptyValue(v) {
  if (v == null) return true;
  if (typeof v === 'boolean') return false;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  return false;
}

/** Accept boolean, yes/true strings, and natural-language acknowledgments from agents/CEO. */
export function normalizeHonestyAck(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', 'confirmed', 'confirm', 'ack', 'acknowledged', 'i confirm', 'i acknowledge'].includes(s)) {
      return true;
    }
    if (['false', 'no', 'n'].includes(s)) return false;
    if (s.includes('no fabricat') || s.includes('honest') || s.includes('acknowledge')) return true;
  }
  return null;
}

export function normalizeFitThreshold(v) {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return v;
}

export function coerceConfirm(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return ['true', 'yes', 'y', 'confirmed', 'confirm'].includes(s);
  }
  return false;
}

export function normalizeIntakePatch(patch = {}) {
  const out = { ...patch };
  if (out.workflow_schedule !== undefined && out.discovery_schedule === undefined) {
    out.discovery_schedule = out.workflow_schedule;
  }
  if (out.discovery_schedule !== undefined) {
    out.discovery_schedule = normalizeDiscoverySchedule(out.discovery_schedule);
  }
  if (out.workflow_schedule !== undefined) {
    out.workflow_schedule = normalizeDiscoverySchedule(out.workflow_schedule);
  }
  if (out.honesty_ack !== undefined) {
    const ack = normalizeHonestyAck(out.honesty_ack);
    if (ack === true) out.honesty_ack = true;
    else if (ack === false) out.honesty_ack = false;
    else delete out.honesty_ack;
  }
  if (out.fit_threshold !== undefined) {
    out.fit_threshold = normalizeFitThreshold(out.fit_threshold);
  }
  if (out.linkedin_profile !== undefined) {
    out.linkedin_profile = normalizeLinkedInUrl(out.linkedin_profile);
  }
  if (out.workflow_goal !== undefined) {
    out.workflow_goal = normalizeWorkflowGoal(out.workflow_goal);
  }
  if (
    out.portal_search_patterns !== undefined ||
    out.linkedin_search_url_pattern !== undefined ||
    out.jobstreet_search_url_pattern !== undefined
  ) {
    const patterns =
      out.portal_search_patterns && typeof out.portal_search_patterns === 'object'
        ? { ...out.portal_search_patterns }
        : {};
    if (out.linkedin_search_url_pattern !== undefined) {
      const v = String(out.linkedin_search_url_pattern || '').trim();
      if (v) patterns['linkedin.com'] = v;
      else delete patterns['linkedin.com'];
    }
    if (out.jobstreet_search_url_pattern !== undefined) {
      const v = String(out.jobstreet_search_url_pattern || '').trim();
      if (v) patterns['jobstreet.com.sg'] = v;
      else delete patterns['jobstreet.com.sg'];
    }
    out.portal_search_patterns = patterns;
    delete out.linkedin_search_url_pattern;
    delete out.jobstreet_search_url_pattern;
  }
  return out;
}

export function validateIntake(intake) {
  const data = intake && typeof intake === 'object' ? intake : {};
  const missing = [];
  for (const key of REQUIRED_FOR_ACTIVE) {
    const v = data[key];
    if (key === 'honesty_ack') {
      if (normalizeHonestyAck(v) !== true) missing.push(key);
    } else if (emptyValue(v)) {
      missing.push(key);
    }
  }
  return { complete: missing.length === 0, missing_fields: missing };
}

function parseIntake(row) {
  try {
    return JSON.parse(row?.intake_json || '{}');
  } catch {
    return {};
  }
}

function profileSummary(row, activeProfileId) {
  const intake = parseIntake(row);
  const validation = validateIntake(intake);
  const titles = Array.isArray(intake.target_titles) ? intake.target_titles.slice(0, 3) : [];
  return {
    id: row.id,
    ceo_user_id: row.ceo_user_id,
    display_name: row.display_name || row.id,
    status: row.status,
    is_active: row.id === activeProfileId,
    version: row.version,
    confirmed_at: row.confirmed_at,
    updated_at: row.updated_at,
    intake_complete: validation.complete,
    missing_fields: validation.missing_fields,
    preview: {
      target_titles: titles,
      locations: intake.locations,
      work_mode: intake.work_mode,
      fit_threshold: intake.fit_threshold,
      workflow_goal: normalizeWorkflowGoal(intake.workflow_goal || 'job_application'),
      workflow_goal_label: workflowGoalLabel(intake.workflow_goal),
      discovery_schedule: normalizeDiscoverySchedule(intake.discovery_schedule),
      workflow_schedule_label: scheduleLabel(intake.discovery_schedule),
    },
  };
}

export function createJobSearchProfileService(getDb) {
  function getCeoSettings(ceoUserId) {
    const db = getDb();
    return db.prepare('SELECT * FROM job_search_ceo_settings WHERE ceo_user_id = ?').get(ceoUserId);
  }

  function getActiveProfileId(ceoUserId) {
    const settings = getCeoSettings(ceoUserId);
    if (settings?.active_profile_id) {
      const row = getRow(ceoUserId, settings.active_profile_id);
      if (row?.status === 'active') return settings.active_profile_id;
      if (row && row.status !== 'active') {
        clearActiveProfileId(ceoUserId);
      }
    }
    const db = getDb();
    const legacy = db
      .prepare(
        `SELECT id FROM job_search_profiles WHERE ceo_user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
      )
      .get(ceoUserId);
    return legacy?.id || null;
  }

  function clearActiveProfileId(ceoUserId) {
    const db = getDb();
    db.prepare(
      `INSERT INTO job_search_ceo_settings (ceo_user_id, active_profile_id, updated_at)
       VALUES (?, NULL, datetime('now'))
       ON CONFLICT(ceo_user_id) DO UPDATE SET active_profile_id = NULL, updated_at = datetime('now')`
    ).run(ceoUserId);
  }

  function setActiveProfileId(ceoUserId, profileId) {
    const db = getDb();
    db.prepare(
      `INSERT INTO job_search_ceo_settings (ceo_user_id, active_profile_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(ceo_user_id) DO UPDATE SET active_profile_id = excluded.active_profile_id, updated_at = datetime('now')`
    ).run(ceoUserId, profileId);
  }

  function getRow(ceoUserId, profileId) {
    const db = getDb();
    return db.prepare('SELECT * FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?').get(ceoUserId, profileId);
  }

  function ensureRow(ceoUserId, profileId, displayName = '') {
    const db = getDb();
    let row = getRow(ceoUserId, profileId);
    if (!row) {
      db.prepare(
        `INSERT INTO job_search_profiles (id, ceo_user_id, display_name, status, intake_json, version, updated_at)
         VALUES (?, ?, ?, 'draft', '{}', 1, datetime('now'))`
      ).run(profileId, ceoUserId, displayName || profileId);
      row = getRow(ceoUserId, profileId);
    }
    return row;
  }

  function resolveProfileId(ceoUserId, profileId) {
    if (profileId) return profileId;
    const active = getActiveProfileId(ceoUserId);
    if (active) return active;
    return null;
  }

  return {
    getActiveProfileId(ceoUserId) {
      return getActiveProfileId(ceoUserId);
    },

    listProfiles(ceoUserId) {
      const db = getDb();
      const activeId = getActiveProfileId(ceoUserId);
      const rows = db
        .prepare(
          `SELECT * FROM job_search_profiles WHERE ceo_user_id = ? ORDER BY updated_at DESC`
        )
        .all(ceoUserId);
      return {
        ceo_user_id: ceoUserId,
        active_profile_id: activeId,
        profiles: rows.map((r) => profileSummary(r, activeId)),
        count: rows.length,
      };
    },

    createProfile(ceoUserId, { profile_id, display_name, patch = {} } = {}) {
      const name = (display_name || profile_id || 'New profile').trim();
      let id = (profile_id || slugifyProfileId(name)).trim().toLowerCase();
      if (!id) id = slugifyProfileId(name);
      const db = getDb();
      const exists = getRow(ceoUserId, id);
      if (exists) {
        throw new Error(`Profile "${id}" already exists for this CEO. Choose another profile_id or update the existing one.`);
      }
      ensureRow(ceoUserId, id, name);
      if (patch && Object.keys(patch).length > 0) {
        this.savePatch(ceoUserId, id, patch);
      }
      return this.getProfile(ceoUserId, id);
    },

    setActiveProfile(ceoUserId, profileId) {
      const row = getRow(ceoUserId, profileId);
      if (!row) throw new Error(`Profile not found: ${profileId}`);
      if (row.status !== 'active') {
        throw new Error(
          `Profile "${profileId}" is ${row.status}. Confirm or reactivate before switching to it.`
        );
      }
      setActiveProfileId(ceoUserId, profileId);
      return {
        ceo_user_id: ceoUserId,
        active_profile_id: profileId,
        profile: this.getProfile(ceoUserId, profileId),
      };
    },

    getProfile(ceoUserId, profileId = null) {
      const pid = resolveProfileId(ceoUserId, profileId);
      if (!pid) {
        return {
          id: null,
          ceo_user_id: ceoUserId,
          status: 'none',
          intake: {},
          intake_complete: false,
          missing_fields: [...REQUIRED_FOR_ACTIVE],
          active_profile_id: null,
        };
      }
      const row = ensureRow(ceoUserId, pid, pid);
      const intake = parseIntake(row);
      const validation = validateIntake(intake);
      const activeId = getActiveProfileId(ceoUserId);
      return {
        id: row.id,
        ceo_user_id: row.ceo_user_id,
        display_name: row.display_name || row.id,
        status: row.status,
        is_active: row.id === activeId,
        active_profile_id: activeId,
        version: row.version,
        confirmed_at: row.confirmed_at,
        updated_at: row.updated_at,
        last_pipeline_run_at: row.last_pipeline_run_at || null,
        intake,
        intake_complete: validation.complete,
        missing_fields: validation.missing_fields,
        workflow_schedule: normalizeDiscoverySchedule(intake.discovery_schedule),
        workflow_schedule_label: scheduleLabel(intake.discovery_schedule),
        ...workflowGoalFromIntake(intake),
      };
    },

    savePatch(ceoUserId, profileId, patch = {}) {
      if (!patch || typeof patch !== 'object') throw new Error('patch object required');
      const pid = profileId || resolveProfileId(ceoUserId, null);
      if (!pid) throw new Error('profile_id required (no active profile)');
      const existing = getRow(ceoUserId, pid);
      if (!existing) ensureRow(ceoUserId, pid, pid);
      const row = getRow(ceoUserId, pid);
      const intake = parseIntake(row);
      if (patch.display_name) {
        const db = getDb();
        db.prepare('UPDATE job_search_profiles SET display_name = ? WHERE ceo_user_id = ? AND id = ?').run(
          String(patch.display_name).trim(),
          ceoUserId,
          pid
        );
        delete patch.display_name;
      }
      const normalized = normalizeIntakePatch(patch);
      for (const key of INTAKE_FIELD_KEYS) {
        if (normalized[key] !== undefined) intake[key] = normalized[key];
      }
      const db = getDb();
      let nextStatus = row.status;
      if (row.status === 'active') nextStatus = 'draft';
      db.prepare(
        `UPDATE job_search_profiles SET intake_json = ?, status = ?, updated_at = datetime('now') WHERE ceo_user_id = ? AND id = ?`
      ).run(JSON.stringify(intake), nextStatus, ceoUserId, pid);
      return this.getProfile(ceoUserId, pid);
    },

    renameProfile(ceoUserId, profileId = null, { display_name, new_profile_id } = {}) {
      const pid = profileId || resolveProfileId(ceoUserId, null);
      if (!pid) throw new Error('profile_id required');
      const row = getRow(ceoUserId, pid);
      if (!row) throw new Error(`Profile not found: ${pid}`);

      const db = getDb();
      let resultId = pid;

      if (display_name && String(display_name).trim()) {
        db.prepare(
          `UPDATE job_search_profiles SET display_name = ?, updated_at = datetime('now') WHERE ceo_user_id = ? AND id = ?`
        ).run(String(display_name).trim(), ceoUserId, pid);
      }

      if (new_profile_id && String(new_profile_id).trim()) {
        const newId = slugifyProfileId(String(new_profile_id).trim());
        if (!newId) throw new Error('new_profile_id invalid');
        if (newId !== pid && getRow(ceoUserId, newId)) {
          throw new Error(`Profile "${newId}" already exists. Choose another id.`);
        }
        if (newId !== pid) {
          db.prepare(
            `INSERT INTO job_search_profiles (id, ceo_user_id, display_name, status, intake_json, version, confirmed_at, last_pipeline_run_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          ).run(
            newId,
            ceoUserId,
            display_name ? String(display_name).trim() : row.display_name || newId,
            row.status,
            row.intake_json,
            row.version,
            row.confirmed_at,
            row.last_pipeline_run_at
          );
          db.prepare(
            `UPDATE job_applications SET profile_id = ? WHERE ceo_user_id = ? AND profile_id = ?`
          ).run(newId, ceoUserId, pid);
          if (getCeoSettings(ceoUserId)?.active_profile_id === pid) setActiveProfileId(ceoUserId, newId);
          db.prepare(`DELETE FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?`).run(ceoUserId, pid);
          resultId = newId;
        }
      }

      if (!display_name && !new_profile_id) {
        throw new Error('display_name or new_profile_id required');
      }

      return { ...this.getProfile(ceoUserId, resultId), renamed_from: pid !== resultId ? pid : undefined };
    },

    deleteProfile(ceoUserId, profileId = null, confirm = false) {
      if (!coerceConfirm(confirm)) throw new Error('confirm: true required to delete profile');
      const pid = profileId || resolveProfileId(ceoUserId, null);
      if (!pid) throw new Error('profile_id required');
      const row = getRow(ceoUserId, pid);
      if (!row) throw new Error(`Profile not found: ${pid}`);

      const wasActivePointer = getCeoSettings(ceoUserId)?.active_profile_id === pid;
      const db = getDb();
      const jobsDeleted = db
        .prepare(`DELETE FROM job_applications WHERE ceo_user_id = ? AND profile_id = ?`)
        .run(ceoUserId, pid).changes;
      db.prepare(`DELETE FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?`).run(ceoUserId, pid);
      if (wasActivePointer) clearActiveProfileId(ceoUserId);

      return {
        deleted: true,
        profile_id: pid,
        ceo_user_id: ceoUserId,
        display_name: row.display_name || pid,
        was_active: wasActivePointer,
        jobs_deleted: jobsDeleted,
      };
    },

    deactivate(ceoUserId, profileId = null) {
      const pid = profileId || resolveProfileId(ceoUserId, null);
      if (!pid) throw new Error('profile_id required');
      const row = getRow(ceoUserId, pid);
      if (!row) throw new Error(`Profile not found: ${pid}`);
      if (row.status === 'inactive') {
        return { ...this.getProfile(ceoUserId, pid), already_inactive: true, pipeline_should_stop: false };
      }
      if (row.status !== 'active') {
        throw new Error(`Only active profiles can be deactivated (current status: ${row.status})`);
      }
      const wasActivePointer = getCeoSettings(ceoUserId)?.active_profile_id === pid;
      const db = getDb();
      db.prepare(
        `UPDATE job_search_profiles SET status = 'inactive', updated_at = datetime('now') WHERE ceo_user_id = ? AND id = ?`
      ).run(ceoUserId, pid);
      if (wasActivePointer) clearActiveProfileId(ceoUserId);
      const profile = this.getProfile(ceoUserId, pid);
      return {
        ...profile,
        deactivated: true,
        pipeline_should_stop: wasActivePointer,
      };
    },

    confirm(ceoUserId, profileId, confirm = false, opts = {}) {
      if (opts?.honesty_ack !== undefined) {
        this.savePatch(ceoUserId, profileId, { honesty_ack: opts.honesty_ack });
      }
      if (!coerceConfirm(confirm)) throw new Error('confirm: true required');
      const pid = profileId || resolveProfileId(ceoUserId, null);
      if (!pid) throw new Error('profile_id required');
      let profile = this.getProfile(ceoUserId, pid);
      if (emptyValue(profile.intake?.workflow_goal)) {
        this.savePatch(ceoUserId, pid, { workflow_goal: 'job_application' });
        profile = this.getProfile(ceoUserId, pid);
      }
      if (!profile.intake_complete) {
        throw new Error(`Profile incomplete. Missing: ${profile.missing_fields.join(', ')}`);
      }
      const intake = { ...profile.intake };
      if (!intake.discovery_schedule) {
        intake.discovery_schedule = 'daily';
      }
      intake.discovery_schedule = normalizeDiscoverySchedule(intake.discovery_schedule);
      intake.workflow_schedule = intake.discovery_schedule;
      if (!intake.workflow_goal) {
        intake.workflow_goal = 'job_application';
      } else {
        intake.workflow_goal = normalizeWorkflowGoal(intake.workflow_goal);
      }
      const db = getDb();
      db.prepare(
        `UPDATE job_search_profiles SET status = 'active', intake_json = ?, confirmed_at = datetime('now'), updated_at = datetime('now') WHERE ceo_user_id = ? AND id = ?`
      ).run(JSON.stringify(intake), ceoUserId, pid);
      setActiveProfileId(ceoUserId, pid);
      return this.getProfile(ceoUserId, pid);
    },

    assertActive(ceoUserId, profileId = null) {
      const pid = profileId || getActiveProfileId(ceoUserId);
      if (!pid) {
        return {
          active: false,
          error: 'No job search profile selected. Ask Job Discovery to list or create a profile.',
          ceo_user_id: ceoUserId,
        };
      }
      const profile = this.getProfile(ceoUserId, pid);
      if (profile.status !== 'active') {
        const msg =
          profile.status === 'inactive'
            ? `Profile "${pid}" is deactivated. Reactivate via job_search_profile_confirm or choose another profile.`
            : `Profile "${pid}" is not active (status: ${profile.status}). Complete intake and confirm.`;
        return {
          active: false,
          error: msg,
          status: profile.status,
          profile_id: pid,
          ceo_user_id: ceoUserId,
          missing_fields: profile.missing_fields,
        };
      }
      return { active: true, profile, profile_id: pid, ceo_user_id: ceoUserId };
    },

    touchPipelineRun(ceoUserId, profileId) {
      const db = getDb();
      db.prepare(
        `UPDATE job_search_profiles SET last_pipeline_run_at = datetime('now'), updated_at = datetime('now') WHERE ceo_user_id = ? AND id = ?`
      ).run(ceoUserId, profileId);
    },

    listActiveProfiles() {
      const db = getDb();
      return db
        .prepare(
          `SELECT ceo_user_id, id, intake_json, last_pipeline_run_at, status
           FROM job_search_profiles WHERE status = 'active' ORDER BY updated_at DESC`
        )
        .all();
    },
  };
}
