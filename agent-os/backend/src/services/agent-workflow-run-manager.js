/**
 * Pause / delete workflow runs with Kanban + delegation cleanup.
 */
import { getDb } from '../db/schema.js';
import * as store from './agent-workflow-store.js';
import { removeKanbanTasksForAgentWorkflowRun } from './agent-workflow-kanban.js';
import { cancelAllListenersForRun } from './agent-workflow-event-listener.js';

function db() {
  return getDb();
}

function cancelDelegationsForRun(runId) {
  const pattern = `%agent_wf_run_id: ${runId}%`;
  const rows = db()
    .prepare(
      `SELECT id FROM agent_delegation_tasks
       WHERE status IN ('pending', 'processing') AND prompt LIKE ?`
    )
    .all(pattern);
  let cancelled = 0;
  for (const row of rows) {
    db()
      .prepare(
        `UPDATE agent_workflow_run_steps SET status = 'failed', error_message = 'run paused/cancelled', completed_at = datetime('now')
         WHERE delegation_task_id = ? AND status IN ('pending', 'in_progress')`
      )
      .run(row.id);
    db()
      .prepare(
        `UPDATE agent_delegation_tasks SET status = 'failed', error_message = 'workflow run cancelled', completed_at = datetime('now') WHERE id = ?`
      )
      .run(row.id);
    cancelled++;
  }
  return cancelled;
}

function cleanupRunArtifacts(runId) {
  cancelAllListenersForRun(runId);
  cancelDelegationsForRun(runId);
  const kanban = removeKanbanTasksForAgentWorkflowRun(runId);
  return kanban;
}

export function pauseRun(runId, ownerUserId, actor, reason = 'paused by user') {
  const run = store.getRun(runId, ownerUserId);
  if (!run) return null;
  if (['paused', 'cancelled', 'completed'].includes(run.status)) return run;

  cleanupRunArtifacts(runId);
  db()
    .prepare(
      `UPDATE agent_workflow_runs SET status = 'paused', error_message = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
    .run(reason, runId);

  db()
    .prepare(
      `UPDATE agent_workflow_run_steps SET status = 'failed', error_message = ?, completed_at = datetime('now')
       WHERE run_id = ? AND status IN ('pending', 'in_progress')`
    )
    .run(reason, runId);

  store.appendAudit(run.definition_id, {
    action: 'run_paused',
    summary: `Run #${run.run_number} paused`,
    changedBy: actor?.id,
    changedByName: actor?.name,
  });
  return store.getRun(runId, ownerUserId);
}

export function deleteRun(runId, ownerUserId, actor) {
  const run = store.getRun(runId, ownerUserId);
  if (!run) return null;

  cleanupRunArtifacts(runId);
  cancelAllListenersForRun(runId);
  db().prepare('DELETE FROM agent_workflow_run_steps WHERE run_id = ?').run(runId);
  db().prepare('DELETE FROM agent_workflow_runs WHERE id = ?').run(runId);

  store.appendAudit(run.definition_id, {
    action: 'run_deleted',
    summary: `Run #${run.run_number} deleted (Kanban cleared)`,
    changedBy: actor?.id,
    changedByName: actor?.name,
  });
  return { deleted: true, run_id: runId };
}

export function pauseAllRuns(ownerUserId, { definitionId = null, actor } = {}) {
  let query = `SELECT id FROM agent_workflow_runs WHERE owner_user_id = ? AND status IN ('running', 'pending')`;
  const params = [ownerUserId];
  if (definitionId) {
    query += ` AND definition_id = ?`;
    params.push(definitionId);
  }
  const rows = db().prepare(query).all(...params);
  const results = [];
  for (const row of rows) {
    results.push(pauseRun(row.id, ownerUserId, actor));
  }
  return { paused: results.length };
}

export function deleteAllRuns(ownerUserId, { definitionId = null, actor } = {}) {
  let query = `SELECT id, definition_id, run_number FROM agent_workflow_runs WHERE owner_user_id = ?`;
  const params = [ownerUserId];
  if (definitionId) {
    query += ` AND definition_id = ?`;
    params.push(definitionId);
  }
  const rows = db().prepare(query).all(...params);
  for (const row of rows) {
    cleanupRunArtifacts(row.id);
    db().prepare('DELETE FROM agent_workflow_run_steps WHERE run_id = ?').run(row.id);
    db().prepare('DELETE FROM agent_workflow_runs WHERE id = ?').run(row.id);
    store.appendAudit(row.definition_id, {
      action: 'run_deleted',
      summary: `Run #${row.run_number} deleted (bulk)`,
      changedBy: actor?.id,
      changedByName: actor?.name,
    });
  }
  return { deleted: rows.length };
}

export function deleteDefinitionWithCleanup(id, ownerUserId, actor) {
  deleteAllRuns(ownerUserId, { definitionId: id, actor });
  return store.deleteDefinition(id, ownerUserId, actor);
}
