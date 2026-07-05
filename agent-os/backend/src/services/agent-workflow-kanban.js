/**
 * Kanban integration for custom agent workflows (separate from job pipeline).
 */
import { getDb } from '../db/schema.js';

export const AGENT_WORKFLOW_TAG = '[agent_workflow:';

function db() {
  return getDb();
}

export function isAgentWorkflowPrompt(prompt) {
  return String(prompt || '').includes(AGENT_WORKFLOW_TAG);
}

export function parseAgentWorkflowMeta(prompt) {
  const text = String(prompt || '');
  const nodeMatch = text.match(/\[agent_workflow:([^\]]+)\]/);
  const runMatch = text.match(/agent_wf_run_id:\s*(\d+)/);
  const defMatch = text.match(/agent_wf_def_id:\s*(\S+)/);
  const typeMatch = text.match(/node_type:\s*(\S+)/);
  return {
    node_id: nodeMatch ? nodeMatch[1] : null,
    run_id: runMatch ? Number(runMatch[1]) : null,
    definition_id: defMatch ? defMatch[1] : null,
    node_type: typeMatch ? typeMatch[1] : null,
  };
}

export function isWorkflowCeoApprovalDescription(description) {
  return String(description || '').includes('node_type: ceo_approval');
}

export function createCeoApprovalKanbanTask({
  title,
  description,
  ownerUserId,
  standupId,
}) {
  db()
    .prepare(
      `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by, standup_id)
       VALUES (?, ?, 'awaiting_confirmation', NULL, 'agent_workflow_ceo', ?)`
    )
    .run(title, description, standupId);
  return db().prepare('SELECT id FROM kanban_tasks ORDER BY id DESC LIMIT 1').get()?.id;
}

export function buildAgentWorkflowDescription({ runId, definitionId, definitionName, nodeId, nodeLabel, nodeType, ownerUserId, summary = '' }) {
  return [
    `${AGENT_WORKFLOW_TAG}${nodeId}]`,
    `agent_wf_run_id: ${runId}`,
    `agent_wf_def_id: ${definitionId}`,
    `owner_user_id: ${ownerUserId}`,
    `node_type: ${nodeType}`,
    `node_label: ${nodeLabel || nodeId}`,
    '',
    `## Workflow`,
    definitionName || definitionId,
    '',
    '## Summary',
    summary || '(in progress)',
  ].join('\n');
}

export function createAgentWorkflowKanbanTask({
  title,
  description,
  agentId,
  standupId,
  delegationTaskId,
}) {
  db()
    .prepare(
      `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by, standup_id, agent_delegation_task_id)
       VALUES (?, ?, 'awaiting_confirmation', ?, 'agent_workflow', ?, ?)`
    )
    .run(title, description, agentId, standupId, delegationTaskId);
  return db().prepare('SELECT id FROM kanban_tasks WHERE agent_delegation_task_id = ?').get(delegationTaskId)?.id;
}

export function completeAgentWorkflowKanbanForDelegation(delegationTaskId, { ok = true } = {}) {
  const row = db().prepare('SELECT id, status FROM kanban_tasks WHERE agent_delegation_task_id = ?').get(delegationTaskId);
  if (!row) return null;
  const newStatus = ok ? 'completed' : 'failed';
  if (row.status === newStatus) return row.id;
  db()
    .prepare(`UPDATE kanban_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newStatus, row.id);
  return row.id;
}

export function upsertCompletedStepKanban({
  runId,
  definitionId,
  definitionName,
  nodeId,
  nodeLabel,
  nodeType,
  agentId,
  ownerUserId,
  summary,
  detail = {},
}) {
  const existing = db()
    .prepare(`SELECT id FROM kanban_tasks WHERE description LIKE ? AND description LIKE ?`)
    .get(`%agent_wf_run_id: ${runId}%`, `%${AGENT_WORKFLOW_TAG}${nodeId}]%`);

  const description = buildAgentWorkflowDescription({
    runId,
    definitionId,
    definitionName,
    nodeId,
    nodeLabel,
    nodeType,
    ownerUserId,
    summary,
  }) + (Object.keys(detail).length ? `\n\n## Details\n\`\`\`json\n${JSON.stringify(detail, null, 2)}\n\`\`\`` : '');

  if (existing?.id) {
    db()
      .prepare(`UPDATE kanban_tasks SET status = 'completed', description = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(description, existing.id);
    return existing.id;
  }

  const title = `${definitionName || 'Workflow'} · ${nodeLabel || nodeId}`;
  db()
    .prepare(
      `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by)
       VALUES (?, ?, 'completed', ?, 'agent_workflow')`
    )
    .run(title, description, agentId || null);
  return db().prepare('SELECT id FROM kanban_tasks ORDER BY id DESC LIMIT 1').get()?.id;
}

export function removeKanbanTasksForAgentWorkflowRun(runId) {
  const rows = db()
    .prepare(`SELECT id FROM kanban_tasks WHERE description LIKE ?`)
    .all(`%agent_wf_run_id: ${runId}%`);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { removed: 0 };
  const placeholders = ids.map(() => '?').join(',');
  db().prepare(`UPDATE kanban_tasks SET standup_id = NULL, agent_delegation_task_id = NULL WHERE id IN (${placeholders})`).run(...ids);
  db().prepare(`DELETE FROM task_messages WHERE task_id IN (${placeholders})`).run(...ids);
  db().prepare(`DELETE FROM kanban_tasks WHERE id IN (${placeholders})`).run(...ids);
  return { removed: ids.length };
}
