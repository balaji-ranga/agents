/**
 * Custom script registry — CRUD, security scan, sandbox execution.
 */
import { randomBytes } from 'crypto';
import { getDb } from '../db/schema.js';
import { runCustomScriptInSandbox } from './custom-script-executor.js';
import { runCustomScriptSecurityReview, scanCustomScriptDraftSync } from './custom-script-security-review.js';

function slugId(name) {
  const base = String(name || 'script')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `script-${base || 'custom'}-${randomBytes(3).toString('hex')}`;
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function sanitizeRow(row, { includeSource = false } = {}) {
  if (!row) return null;
  const scan = parseJson(row.scan_result_json, null);
  const out = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    language: row.language,
    runtime_profile: row.runtime_profile,
    scan_status: row.scan_status,
    risk_level: row.risk_level,
    status: row.status,
    owner_user_id: row.owner_user_id,
    owner_role: row.owner_role,
    is_platform: !!row.is_platform,
    last_run_at: row.last_run_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    scan_result: scan,
    llm_certified: scan?.llm_review?.certified ?? null,
    byte_size: scan?.byte_size ?? (row.source ? Buffer.byteLength(row.source, 'utf8') : 0),
    can_edit: false,
    can_delete: false,
  };
  if (includeSource) out.source = row.source;
  return out;
}

function canView(row, authUser) {
  if (!row || !authUser) return false;
  if (authUser.role === 'admin') return true;
  if (row.is_platform && row.owner_role === 'admin') return true;
  return row.owner_user_id === authUser.id && row.owner_role === 'ceo';
}

function canEdit(row, authUser) {
  if (!canView(row, authUser)) return false;
  if (authUser.role === 'admin') return true;
  return row.owner_user_id === authUser.id && row.owner_role === 'ceo' && !row.is_platform;
}

function canDelete(row, authUser) {
  return canEdit(row, authUser);
}

function applyPermissions(script, authUser, row) {
  script.can_edit = canEdit(row, authUser);
  script.can_delete = canDelete(row, authUser);
  script.is_mine = row.owner_user_id === authUser.id;
  script.is_shared = !!row.is_platform && row.owner_role === 'admin';
}

function deriveStatusFromScan(scan) {
  if (!scan?.passed) return { scan_status: 'rejected', status: 'draft', risk_level: scan?.risk_level || 'critical' };
  return { scan_status: 'approved', status: 'approved', risk_level: scan.risk_level || 'low' };
}

function isPlatformAdmin(authUser) {
  return authUser?.role === 'admin' && !authUser?.impersonation;
}

export function listCustomScripts(authUser, { forWorkflow = false } = {}) {
  const db = getDb();
  let rows;
  if (isPlatformAdmin(authUser)) {
    rows = db
      .prepare(
        `SELECT * FROM custom_scripts WHERE is_platform = 1 AND owner_role = 'admin' ORDER BY name ASC`
      )
      .all();
  } else {
    rows = db
      .prepare(
        `SELECT * FROM custom_scripts
         WHERE (owner_user_id = ? AND owner_role = 'ceo')
            OR (is_platform = 1 AND owner_role = 'admin')
         ORDER BY is_platform DESC, name ASC`
      )
      .all(authUser.id);
  }
  if (forWorkflow) {
    rows = rows.filter((r) => r.status === 'approved' && r.scan_status === 'approved');
  }
  return rows.map((r) => {
    const s = sanitizeRow(r);
    applyPermissions(s, authUser, r);
    return s;
  });
}

export function getCustomScript(id, authUser, { includeSource = false } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM custom_scripts WHERE id = ?').get(id);
  if (!row || !canView(row, authUser)) return null;
  const s = sanitizeRow(row, { includeSource });
  applyPermissions(s, authUser, row);
  return s;
}

export function getApprovedScriptForRun(id, ownerUserId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM custom_scripts
       WHERE id = ? AND status = 'approved' AND scan_status = 'approved'
         AND (owner_user_id = ? OR is_platform = 1)`
    )
    .get(id, ownerUserId);
  return row || null;
}

/** Quick static-only preview (no LLM). */
export function scanCustomScriptDraft({ source, language, runtimeProfile }) {
  return scanCustomScriptDraftSync({ source, language, runtimeProfile });
}

/** Full static + LLM security review. */
export async function scanCustomScriptDraftFull(body = {}) {
  return runCustomScriptSecurityReview({
    source: body.source,
    language: body.language,
    runtimeProfile: body.runtime_profile || body.runtimeProfile,
    scriptName: body.name || body.scriptName,
  });
}

export async function createCustomScript(authUser, body = {}) {
  const name = String(body.name || '').trim();
  const source = String(body.source || '');
  const language = String(body.language || 'python').toLowerCase();
  const runtimeProfile = String(body.runtime_profile || body.runtimeProfile || 'restricted').toLowerCase();
  if (!name) throw new Error('Name is required');
  if (!source.trim()) throw new Error('Script source is required');
  if (!['python', 'javascript', 'js'].includes(language)) {
    throw new Error('language must be python or javascript');
  }
  const lang = language === 'js' ? 'javascript' : language;
  const scan = await runCustomScriptSecurityReview({
    source,
    language: lang,
    runtimeProfile,
    scriptName: name,
  });
  const derived = deriveStatusFromScan(scan);
  const id = body.id?.trim() || slugId(name);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO custom_scripts (
      id, name, description, language, runtime_profile, source,
      scan_result_json, scan_status, risk_level, status,
      owner_user_id, owner_role, is_platform, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    String(body.description || ''),
    lang,
    runtimeProfile,
    source,
    JSON.stringify(scan),
    derived.scan_status,
    derived.risk_level,
    derived.status,
    authUser.id,
    authUser.role,
    authUser.role === 'admin' && body.is_platform ? 1 : 0,
    now,
    now
  );
  const row = db.prepare('SELECT * FROM custom_scripts WHERE id = ?').get(id);
  const s = sanitizeRow(row, { includeSource: true });
  applyPermissions(s, authUser, row);
  return s;
}

export async function updateCustomScript(id, authUser, body = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM custom_scripts WHERE id = ?').get(id);
  if (!row) throw new Error('Script not found');
  if (!canEdit(row, authUser)) throw new Error('Not allowed to edit this script');

  const name = body.name != null ? String(body.name).trim() : row.name;
  const description = body.description != null ? String(body.description) : row.description;
  const source = body.source != null ? String(body.source) : row.source;
  const language = body.language != null ? String(body.language).toLowerCase() : row.language;
  const lang = language === 'js' ? 'javascript' : language;
  const runtimeProfile =
    body.runtime_profile != null || body.runtimeProfile != null
      ? String(body.runtime_profile || body.runtimeProfile).toLowerCase()
      : row.runtime_profile;

  const sourceChanged = body.source != null && body.source !== row.source;
  const profileChanged = runtimeProfile !== row.runtime_profile;
  const langChanged = lang !== row.language;

  let scan = parseJson(row.scan_result_json, null);
  let scan_status = row.scan_status;
  let status = row.status;
  let risk_level = row.risk_level;

  if (sourceChanged || profileChanged || langChanged) {
    scan = await runCustomScriptSecurityReview({
      source,
      language: lang,
      runtimeProfile,
      scriptName: name,
    });
    const derived = deriveStatusFromScan(scan);
    scan_status = derived.scan_status;
    status = derived.status;
    risk_level = derived.risk_level;
  }

  if (body.status === 'disabled' && scan_status === 'approved') {
    status = 'disabled';
  } else if (body.status === 'approved' && scan_status === 'approved') {
    status = 'approved';
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE custom_scripts SET
      name = ?, description = ?, language = ?, runtime_profile = ?, source = ?,
      scan_result_json = ?, scan_status = ?, risk_level = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    name,
    description,
    lang,
    runtimeProfile,
    source,
    JSON.stringify(scan),
    scan_status,
    risk_level,
    status,
    now,
    id
  );
  const updated = db.prepare('SELECT * FROM custom_scripts WHERE id = ?').get(id);
  const s = sanitizeRow(updated, { includeSource: true });
  applyPermissions(s, authUser, updated);
  return s;
}

export function deleteCustomScript(id, authUser) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM custom_scripts WHERE id = ?').get(id);
  if (!row) throw new Error('Script not found');
  if (!canDelete(row, authUser)) throw new Error('Not allowed to delete this script');
  db.prepare('DELETE FROM custom_scripts WHERE id = ?').run(id);
  return { ok: true, id };
}

export async function executeCustomScript(scriptId, authUser, { inputs = {}, context = {}, timeoutMs } = {}) {
  const db = getDb();
  const row = getApprovedScriptForRun(scriptId, authUser?.id);
  if (!row) throw new Error('Approved script not found or not accessible');
  if (!canView(row, authUser)) throw new Error('Not allowed to run this script');

  const result = await runCustomScriptInSandbox({
    source: row.source,
    language: row.language,
    runtimeProfile: row.runtime_profile,
    inputs,
    context,
    timeoutMs,
  });

  const now = new Date().toISOString();
  if (result.ok) {
    db.prepare('UPDATE custom_scripts SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(
      now,
      now,
      scriptId
    );
    return { ok: true, output: result.output, script_id: scriptId, language: row.language };
  }
  db.prepare('UPDATE custom_scripts SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
    now,
    result.error,
    now,
    scriptId
  );
  throw new Error(result.error || 'Script execution failed');
}

export async function executeCustomScriptTask(resolvedInputs, nodeConfig = {}, context = {}, ownerUserId) {
  const scriptId = nodeConfig.customScriptId || nodeConfig.scriptId;
  if (!scriptId) throw new Error('No custom script selected');
  const authUser = { id: ownerUserId, role: 'ceo' };
  const inputs = {
    ...resolvedInputs,
    payload: resolvedInputs.payload || resolvedInputs.input || resolvedInputs.text,
  };
  const runContext = {
    workflow: context?.definition_id || null,
    run_id: context?.run_id || null,
    node_outputs: context?.node_outputs || {},
    initial_input: context?.initial_input || '',
    workflow_variables: context?.workflow_variables || context?.variables || {},
    variables: context?.workflow_variables || context?.variables || {},
  };
  const result = await executeCustomScript(scriptId, authUser, {
    inputs,
    context: runContext,
    timeoutMs: nodeConfig.timeoutMs || nodeConfig.timeout_ms,
  });
  const out = result.output || {};
  // Explicit fields must win over ...out (scripts sometimes echo nested decision JSON)
  const decision = out.decision != null ? String(out.decision) : '';
  let adjustments = out.adjustments != null ? out.adjustments : '';
  if (Array.isArray(adjustments)) adjustments = adjustments.join('\n');
  else if (adjustments != null && typeof adjustments === 'object') adjustments = JSON.stringify(adjustments);
  else adjustments = String(adjustments || '');
  // If checker put the whole JSON into adjustments, unwrap
  if (adjustments.trim().startsWith('{')) {
    try {
      const nested = JSON.parse(adjustments);
      if (nested && typeof nested === 'object') {
        if (nested.adjustments != null) {
          adjustments = Array.isArray(nested.adjustments)
            ? nested.adjustments.join('\n')
            : String(nested.adjustments);
        } else if (nested.notes != null && !adjustments) {
          adjustments = String(nested.notes);
        }
      }
    } catch {
      /* keep raw */
    }
  }
  if (!adjustments && out.notes) adjustments = String(out.notes);
  return {
    ...out,
    text: out.text != null ? String(out.text) : JSON.stringify(out),
    result: out,
    ok: out.ok !== false && out.ok !== 'false',
    decision,
    adjustments,
    plan_json: out.plan_json != null ? String(out.plan_json) : '',
    has_sells: out.has_sells != null ? String(out.has_sells) : '',
    has_holds: out.has_holds != null ? String(out.has_holds) : '',
    place_body: out.place_body != null ? String(out.place_body) : '',
    holds_body: out.holds_body != null ? String(out.holds_body) : '',
    script_id: scriptId,
    language: result.language,
  };
}
