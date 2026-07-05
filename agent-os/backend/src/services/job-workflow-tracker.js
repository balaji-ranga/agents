/**
 * Job search workflow runs — numbered per profile, step progress + audit trail.
 */
import { getDb } from '../db/schema.js';
import { normalizeWorkflowGoal } from './job-applicant-workflow-goal.js';
import {
  removeKanbanTasksForWorkflowRun,
  cancelPendingPipelineDelegationsAndKanban,
} from './kanban-workflow-stage.js';

export const STEP_STATUS = ['pending', 'in_progress', 'completed', 'failed', 'skipped'];

export function stepTemplateForGoal(workflowGoal) {
  const goal = normalizeWorkflowGoal(workflowGoal);
  const base = [
    { key: 'workflow_init', label: 'Workflow started', order: 1 },
    { key: 'job_discovery', label: 'Job discovery', order: 2 },
    { key: 'fit_scoring', label: 'Fit scoring', order: 3 },
    { key: 'resume_tailoring', label: 'Resume tailoring', order: 4 },
    { key: 'ceo_review', label: 'CEO review Kanban submitted', order: 5 },
    { key: 'ceo_confirm', label: 'CEO confirmation', order: 6 },
  ];
  if (goal === 'scoring_summary') {
    return [
      ...base,
      { key: 'acknowledge', label: 'Jobs acknowledged (scoring summary)', order: 7 },
      { key: 'workflow_complete', label: 'Workflow complete', order: 8 },
    ];
  }
  return [
    ...base,
    { key: 'prefill', label: 'Application prefill', order: 7 },
    { key: 'application', label: 'Application Agent', order: 8 },
    { key: 'workflow_complete', label: 'Workflow complete', order: 9 },
  ];
}

function parseJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeActor(actor) {
  if (!actor) return { type: 'system', id: 'system' };
  return {
    type: actor.type || actor.actor_type || 'system',
    id: String(actor.id || actor.actor_id || 'system'),
  };
}

export function createJobWorkflowTracker(getDbFn = getDb) {
  function db() {
    return getDbFn();
  }

  function nextWorkflowNumber(ceoUserId, profileId) {
    const row = db()
      .prepare(
        `SELECT COALESCE(MAX(workflow_number), 0) + 1 AS n FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ?`
      )
      .get(ceoUserId, profileId);
    return row?.n || 1;
  }

  function startRun({
    ceoUserId,
    profileId,
    workflowGoal = 'job_application',
    trigger = 'manual',
    actor = null,
    metadata = {},
  } = {}) {
    if (!ceoUserId || !profileId) throw new Error('ceo_user_id and profile_id required');
    const goal = normalizeWorkflowGoal(workflowGoal);
    const workflowNumber = nextWorkflowNumber(ceoUserId, profileId);
    const startedAt = nowIso();
    const ins = db()
      .prepare(
        `INSERT INTO job_workflow_runs
         (workflow_number, ceo_user_id, profile_id, workflow_goal, status, trigger, started_at, metadata_json)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(workflowNumber, ceoUserId, profileId, goal, trigger, startedAt, JSON.stringify(metadata || {}));
    const runId = ins.lastInsertRowid;
    const template = stepTemplateForGoal(goal);
    const stepIns = db().prepare(
      `INSERT INTO job_workflow_steps (workflow_run_id, step_key, step_label, step_order, status)
       VALUES (?, ?, ?, ?, 'pending')`
    );
    for (const s of template) {
      stepIns.run(runId, s.key, s.label, s.order);
    }
    const act = normalizeActor(actor);
    beginStep(runId, 'workflow_init', act, { trigger, workflow_number: workflowNumber });
    completeStep(runId, 'workflow_init', act, { message: 'Workflow run created' });
    return getRun(runId);
  }

  function getStepRow(runId, stepKey) {
    return db()
      .prepare(`SELECT * FROM job_workflow_steps WHERE workflow_run_id = ? AND step_key = ?`)
      .get(runId, stepKey);
  }

  function beginStep(runId, stepKey, actor, detail = {}) {
    const row = getStepRow(runId, stepKey);
    if (!row) return null;
    const act = normalizeActor(actor);
    const merged = { ...parseJson(row.detail_json), ...detail, last_event: 'started' };
    db()
      .prepare(
        `UPDATE job_workflow_steps SET status = 'in_progress', actor_type = ?, actor_id = ?,
         started_at = COALESCE(started_at, ?), detail_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(act.type, act.id, nowIso(), JSON.stringify(merged), nowIso(), row.id);
    return getStepRow(runId, stepKey);
  }

  function completeStep(runId, stepKey, actor, detail = {}) {
    const row = getStepRow(runId, stepKey);
    if (!row) return null;
    const act = normalizeActor(actor);
    const merged = { ...parseJson(row.detail_json), ...detail, last_event: 'completed' };
    db()
      .prepare(
        `UPDATE job_workflow_steps SET status = 'completed', actor_type = ?, actor_id = ?,
         started_at = COALESCE(started_at, ?), completed_at = ?, detail_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(act.type, act.id, nowIso(), nowIso(), JSON.stringify(merged), nowIso(), row.id);
    return getStepRow(runId, stepKey);
  }

  function failStep(runId, stepKey, actor, detail = {}) {
    const row = getStepRow(runId, stepKey);
    if (!row) return null;
    if (row.status === 'completed') return getStepRow(runId, stepKey);
    const act = normalizeActor(actor);
    const merged = { ...parseJson(row.detail_json), ...detail, last_event: 'failed' };
    db()
      .prepare(
        `UPDATE job_workflow_steps SET status = 'failed', actor_type = ?, actor_id = ?,
         completed_at = ?, detail_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(act.type, act.id, nowIso(), JSON.stringify(merged), nowIso(), row.id);
    db()
      .prepare(`UPDATE job_workflow_runs SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(nowIso(), nowIso(), runId);
    return getStepRow(runId, stepKey);
  }

  function skipStep(runId, stepKey, actor, detail = {}) {
    const row = getStepRow(runId, stepKey);
    if (!row) return null;
    const act = normalizeActor(actor);
    const merged = { ...parseJson(row.detail_json), ...detail, last_event: 'skipped' };
    db()
      .prepare(
        `UPDATE job_workflow_steps SET status = 'skipped', actor_type = ?, actor_id = ?,
         completed_at = ?, detail_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(act.type, act.id, nowIso(), JSON.stringify(merged), nowIso(), row.id);
    return getStepRow(runId, stepKey);
  }

  function completeRun(runId, actor, detail = {}) {
    const act = normalizeActor(actor);
    completeStep(runId, 'workflow_complete', act, detail);
    db()
      .prepare(
        `UPDATE job_workflow_runs SET status = 'completed', completed_at = ?, updated_at = ?,
         metadata_json = ? WHERE id = ?`
      )
      .run(
        nowIso(),
        nowIso(),
        JSON.stringify({ ...detail, completed_by: act }),
        runId
      );
    return getRun(runId);
  }

  function failInProgressStep(runId, actor, detail = {}) {
    const row = db()
      .prepare(
        `SELECT step_key FROM job_workflow_steps WHERE workflow_run_id = ? AND status = 'in_progress' ORDER BY step_order DESC LIMIT 1`
      )
      .get(runId);
    const stepKey = row?.step_key || 'resume_tailoring';
    return failStep(runId, stepKey, actor, detail);
  }

  /** Clear in_progress steps left on failed runs (recovery after partial workflow errors). */
  function repairStuckSteps(runId) {
    const rows = db()
      .prepare(`SELECT id, detail_json FROM job_workflow_steps WHERE workflow_run_id = ? AND status = 'in_progress'`)
      .all(runId);
    for (const row of rows) {
      const merged = { ...parseJson(row.detail_json), last_event: 'failed', error: 'workflow aborted — superseded by recovery run' };
      db()
        .prepare(
          `UPDATE job_workflow_steps SET status = 'failed', completed_at = ?, updated_at = ?, detail_json = ? WHERE id = ?`
        )
        .run(nowIso(), nowIso(), JSON.stringify(merged), row.id);
    }
  }

  function linkKanban(runId, kanbanTaskId) {
    db()
      .prepare(`UPDATE job_workflow_runs SET kanban_ceo_review_task_id = ?, updated_at = ? WHERE id = ?`)
      .run(kanbanTaskId, nowIso(), runId);
  }

  function getRun(runId) {
    const run = db().prepare(`SELECT * FROM job_workflow_runs WHERE id = ?`).get(runId);
    if (!run) return null;
    return formatRun(run);
  }

  function getRunByNumber(ceoUserId, profileId, workflowNumber) {
    const run = db()
      .prepare(
        `SELECT * FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ? AND workflow_number = ?`
      )
      .get(ceoUserId, profileId, workflowNumber);
    if (!run) return null;
    return formatRun(run);
  }

  function formatRun(run) {
    const steps = db()
      .prepare(`SELECT * FROM job_workflow_steps WHERE workflow_run_id = ? ORDER BY step_order ASC`)
      .all(run.id)
      .map(formatStep);
    const completed = steps.filter((s) => s.status === 'completed').length;
    const pending = steps.filter((s) => s.status === 'pending').length;
    const inProgress = steps.filter((s) => s.status === 'in_progress').length;
    return {
      workflow_id: run.id,
      workflow_number: run.workflow_number,
      ceo_user_id: run.ceo_user_id,
      profile_id: run.profile_id,
      workflow_goal: run.workflow_goal,
      status: run.status,
      trigger: run.trigger,
      started_at: run.started_at,
      completed_at: run.completed_at,
      kanban_ceo_review_task_id: run.kanban_ceo_review_task_id,
      metadata: parseJson(run.metadata_json),
      progress: {
        total_steps: steps.length,
        completed_steps: completed,
        pending_steps: pending,
        in_progress_steps: inProgress,
        percent: steps.length ? Math.round((completed / steps.length) * 100) : 0,
      },
      steps,
      completed_steps: steps.filter((s) => s.status === 'completed'),
      pending_steps: steps.filter((s) => s.status === 'pending' || s.status === 'in_progress'),
      audit_trail: steps
        .filter((s) => s.started_at || s.completed_at)
        .flatMap((s) => {
          const events = [];
          if (s.started_at) {
            events.push({
              step_key: s.step_key,
              step_label: s.step_label,
              event: 'started',
              at: s.started_at,
              actor_type: s.actor_type,
              actor_id: s.actor_id,
              detail: s.detail,
            });
          }
          if (s.completed_at && s.status !== 'pending' && s.status !== 'in_progress') {
            events.push({
              step_key: s.step_key,
              step_label: s.step_label,
              event: s.status,
              at: s.completed_at,
              actor_type: s.actor_type,
              actor_id: s.actor_id,
              detail: s.detail,
            });
          }
          return events;
        })
        .sort((a, b) => String(a.at).localeCompare(String(b.at))),
    };
  }

  function formatStep(row) {
    return {
      step_key: row.step_key,
      step_label: row.step_label,
      step_order: row.step_order,
      status: row.status,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      started_at: row.started_at,
      completed_at: row.completed_at,
      detail: parseJson(row.detail_json),
    };
  }

  function supersedeRunningRuns(ceoUserId, profileId, actor = null, detail = {}) {
    const act = normalizeActor(actor || { type: 'system', id: 'workflow_supersede' });
    const runs = db()
      .prepare(
        `SELECT * FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ? AND status = 'running'`
      )
      .all(ceoUserId, profileId);
    if (runs.length) {
      cancelPendingPipelineDelegationsAndKanban('workflow superseded');
    }
    for (const run of runs) {
      removeKanbanTasksForWorkflowRun(run.id);
      repairStuckSteps(run.id);
      const openSteps = db()
        .prepare(
          `SELECT step_key FROM job_workflow_steps WHERE workflow_run_id = ? AND status IN ('pending', 'in_progress')`
        )
        .all(run.id);
      for (const s of openSteps) {
        skipStep(run.id, s.step_key, act, { ...detail, superseded: true });
      }
      const meta = { ...parseJson(run.metadata_json), superseded: true, ...detail };
      db()
        .prepare(
          `UPDATE job_workflow_runs SET status = 'superseded', completed_at = ?, updated_at = ?, metadata_json = ? WHERE id = ?`
        )
        .run(nowIso(), nowIso(), JSON.stringify(meta), run.id);
    }
    return runs.length;
  }

  function findActiveRun(ceoUserId, profileId) {
    const run = db()
      .prepare(
        `SELECT * FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ? AND status = 'running'
         ORDER BY id DESC LIMIT 1`
      )
      .get(ceoUserId, profileId);
    return run ? formatRun(run) : null;
  }

  function findRunAwaitingCeoConfirm(ceoUserId, profileId) {
    const runs = db()
      .prepare(
        `SELECT * FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ? AND status = 'running'
         ORDER BY id DESC LIMIT 5`
      )
      .all(ceoUserId, profileId);
    for (const run of runs) {
      const ceoReview = getStepRow(run.id, 'ceo_review');
      const ceoConfirm = getStepRow(run.id, 'ceo_confirm');
      if (ceoReview?.status === 'completed' && ['pending', 'in_progress'].includes(ceoConfirm?.status)) {
        return formatRun(run);
      }
    }
    return findActiveRun(ceoUserId, profileId);
  }

  function listRuns(ceoUserId, profileId, { limit = 20 } = {}) {
    const rows = db()
      .prepare(
        `SELECT * FROM job_workflow_runs WHERE ceo_user_id = ? AND profile_id = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(ceoUserId, profileId, Math.min(limit, 100));
    return rows.map((r) => {
      const brief = formatRun(r);
      return {
        workflow_id: brief.workflow_id,
        workflow_number: brief.workflow_number,
        profile_id: brief.profile_id,
        workflow_goal: brief.workflow_goal,
        status: brief.status,
        trigger: brief.trigger,
        started_at: brief.started_at,
        completed_at: brief.completed_at,
        progress: brief.progress,
      };
    });
  }

  return {
    startRun,
    beginStep,
    completeStep,
    failStep,
    failInProgressStep,
    repairStuckSteps,
    skipStep,
    completeRun,
    linkKanban,
    getRun,
    getRunByNumber,
    supersedeRunningRuns,
    findActiveRun,
    findRunAwaitingCeoConfirm,
    listRuns,
    stepTemplateForGoal,
  };
}

let _defaultTracker = null;
export function getJobWorkflowTracker(getDbFn = getDb) {
  if (getDbFn === getDb) {
    if (!_defaultTracker) _defaultTracker = createJobWorkflowTracker(getDb);
    return _defaultTracker;
  }
  return createJobWorkflowTracker(getDbFn);
}

export function actorFromRequest(req, fallbackUserId = 'ceo') {
  const agent = req?.headers?.['x-openclaw-agent-id'] || req?.headers?.['x-agent-id'];
  if (agent) return { type: 'agent', id: String(agent) };
  const user =
    req?.headers?.['x-ceo-user-id'] ||
    req?.headers?.['x-user-id'] ||
    req?.body?.ceo_user_id ||
    fallbackUserId;
  return { type: 'user', id: String(user) };
}
