/**
 * Agent workflow definitions: draft/publish, audit trail, run listing.
 */
import { getDb } from '../db/schema.js';

function db() {
  return getDb();
}

function slugify(name) {
  const base = String(name || 'workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${base || 'workflow'}-${Date.now().toString(36)}`;
}

function parseGraph(json) {
  try {
    const g = typeof json === 'string' ? JSON.parse(json) : json;
    return {
      nodes: Array.isArray(g?.nodes) ? g.nodes : [],
      edges: Array.isArray(g?.edges) ? g.edges : [],
      viewport: g?.viewport || { x: 0, y: 0, zoom: 1 },
    };
  } catch {
    return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  }
}

function rowToDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    owner_user_id: row.owner_user_id,
    status: row.status,
    draft_graph: parseGraph(row.draft_graph_json),
    published_graph: row.published_graph_json ? parseGraph(row.published_graph_json) : null,
    schedule_cron: row.schedule_cron || '',
    chat_trigger_phrase: row.chat_trigger_phrase || '',
    trigger_modes: (row.trigger_modes || 'manual').split(',').map((s) => s.trim()).filter(Boolean),
    paused: !!row.paused,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function appendAudit(definitionId, { action, summary, changedBy, changedByName, diff = null }) {
  db()
    .prepare(
      `INSERT INTO agent_workflow_audit (definition_id, action, summary, changed_by, changed_by_name, diff_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      definitionId,
      action,
      summary || '',
      changedBy || null,
      changedByName || null,
      diff ? JSON.stringify(diff) : null
    );
}

export function listDefinitions(ownerUserId) {
  const rows = db()
    .prepare(
      `SELECT * FROM agent_workflow_definitions WHERE owner_user_id = ? ORDER BY updated_at DESC`
    )
    .all(ownerUserId);
  return rows.map(rowToDefinition);
}

export function getDefinition(id, ownerUserId = null) {
  const row = ownerUserId
    ? db().prepare('SELECT * FROM agent_workflow_definitions WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId)
    : db().prepare('SELECT * FROM agent_workflow_definitions WHERE id = ?').get(id);
  return rowToDefinition(row);
}

export function createDefinition({
  name,
  description,
  ownerUserId,
  actor,
  graph = null,
  trigger_modes = ['manual'],
  schedule_cron = '',
  chat_trigger_phrase = '',
}) {
  const id = slugify(name);
  const normalized = normalizeTriggerSettings(trigger_modes, schedule_cron, chat_trigger_phrase);
  const draftGraph = syncTriggerNodeInGraph(
    graph || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    normalized
  );
  db()
    .prepare(
      `INSERT INTO agent_workflow_definitions (id, name, description, owner_user_id, draft_graph_json, status, schedule_cron, chat_trigger_phrase, trigger_modes)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
    )
    .run(
      id,
      name.trim(),
      (description || '').trim(),
      ownerUserId,
      JSON.stringify(draftGraph),
      normalized.schedule_cron,
      normalized.chat_trigger_phrase,
      normalized.trigger_modes.join(',')
    );
  appendAudit(id, {
    action: 'created',
    summary: `Created workflow "${name}"`,
    changedBy: actor?.id,
    changedByName: actor?.name,
  });
  return getDefinition(id, ownerUserId);
}

export function updateDraft(id, ownerUserId, patch, actor) {
  const existing = getDefinition(id, ownerUserId);
  if (!existing) return null;

  const name = patch.name != null ? String(patch.name).trim() : existing.name;
  const description = patch.description != null ? String(patch.description).trim() : existing.description;
  const draftGraph = patch.graph != null ? patch.graph : existing.draft_graph;
  const normalized = normalizeTriggerSettings(
    patch.trigger_modes != null ? patch.trigger_modes : existing.trigger_modes,
    patch.schedule_cron != null ? patch.schedule_cron : existing.schedule_cron,
    patch.chat_trigger_phrase != null ? patch.chat_trigger_phrase : existing.chat_trigger_phrase
  );
  const { trigger_modes, schedule_cron, chat_trigger_phrase } = normalized;

  db()
    .prepare(
      `UPDATE agent_workflow_definitions
       SET name = ?, description = ?, draft_graph_json = ?, schedule_cron = ?,
           chat_trigger_phrase = ?, trigger_modes = ?, updated_at = datetime('now')
       WHERE id = ? AND owner_user_id = ?`
    )
    .run(name, description, JSON.stringify(draftGraph), schedule_cron, chat_trigger_phrase, trigger_modes.join(','), id, ownerUserId);

  appendAudit(id, {
    action: 'updated_draft',
    summary: `Updated draft for "${name}"`,
    changedBy: actor?.id,
    changedByName: actor?.name,
    diff: { fields: Object.keys(patch) },
  });
  if (existing.status === 'published') syncWorkflowScheduleRegistry(id);
  return getDefinition(id, ownerUserId);
}

export function publishDefinition(id, ownerUserId, actor) {
  const def = getDefinition(id, ownerUserId);
  if (!def) return null;
  if (!def.draft_graph?.nodes?.length) {
    throw new Error('Workflow must have at least one node before publishing');
  }
  const hasTrigger = def.draft_graph.nodes.some((n) => n.type === 'trigger');
  if (!hasTrigger) throw new Error('Workflow must include a Trigger node');

  db()
    .prepare(
      `UPDATE agent_workflow_definitions
       SET status = 'published', published_graph_json = draft_graph_json, updated_at = datetime('now')
       WHERE id = ? AND owner_user_id = ?`
    )
    .run(id, ownerUserId);

  appendAudit(id, {
    action: 'published',
    summary: `Published workflow "${def.name}" (replaces previous published version)`,
    changedBy: actor?.id,
    changedByName: actor?.name,
    diff: { node_count: def.draft_graph.nodes.length, edge_count: def.draft_graph.edges.length },
  });
  syncWorkflowScheduleRegistry(id);
  return getDefinition(id, ownerUserId);
}

export function listAudit(definitionId, ownerUserId, limit = 50) {
  const def = getDefinition(definitionId, ownerUserId);
  if (!def) return [];
  return db()
    .prepare(
      `SELECT id, action, summary, changed_by, changed_by_name, diff_json, created_at
       FROM agent_workflow_audit WHERE definition_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(definitionId, limit)
    .map((r) => ({
      ...r,
      diff: r.diff_json ? JSON.parse(r.diff_json) : null,
    }));
}

export function listRuns(definitionId, ownerUserId, limit = 30) {
  const def = getDefinition(definitionId, ownerUserId);
  if (!def) return [];
  return db()
    .prepare(
      `SELECT * FROM agent_workflow_runs WHERE definition_id = ? AND owner_user_id = ?
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(definitionId, ownerUserId, limit)
    .map(formatRunRow);
}

export function listAllRuns(ownerUserId, limit = 50) {
  return db()
    .prepare(
      `SELECT r.*, d.name AS definition_name
       FROM agent_workflow_runs r
       JOIN agent_workflow_definitions d ON d.id = r.definition_id
       WHERE r.owner_user_id = ?
       ORDER BY r.started_at DESC LIMIT ?`
    )
    .all(ownerUserId, limit)
    .map((row) => ({ ...formatRunRow(row), definition_name: row.definition_name }));
}

function formatRunRow(row) {
  let context = {};
  try {
    context = JSON.parse(row.context_json || '{}');
  } catch (_) {}
  return {
    id: row.id,
    run_number: row.run_number,
    definition_id: row.definition_id,
    owner_user_id: row.owner_user_id,
    status: row.status,
    trigger: row.trigger,
    progress_pct: row.progress_pct ?? 0,
    context,
    standup_id: row.standup_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    updated_at: row.updated_at,
  };
}

export function getRun(runId, ownerUserId = null) {
  const row = ownerUserId
    ? db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ? AND owner_user_id = ?').get(runId, ownerUserId)
    : db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
  if (!row) return null;
  const steps = db()
    .prepare('SELECT * FROM agent_workflow_run_steps WHERE run_id = ? ORDER BY id ASC')
    .all(runId)
    .map((s) => ({
      ...s,
      input: s.input_json ? JSON.parse(s.input_json) : null,
      output: s.output_json ? JSON.parse(s.output_json) : null,
    }));
  const def = getDefinition(row.definition_id);
  return {
    ...formatRunRow(row),
    definition_name: def?.name,
    steps,
  };
}

export function deleteDefinition(id, ownerUserId, actor) {
  const def = getDefinition(id, ownerUserId);
  if (!def) return false;
  db().prepare('DELETE FROM agent_workflow_run_steps WHERE run_id IN (SELECT id FROM agent_workflow_runs WHERE definition_id = ?)').run(id);
  db().prepare('DELETE FROM agent_workflow_runs WHERE definition_id = ?').run(id);
  db().prepare('DELETE FROM agent_workflow_audit WHERE definition_id = ?').run(id);
  db().prepare('DELETE FROM agent_workflow_definitions WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId);
  removeWorkflowSchedule(id);
  return true;
}

export function setPaused(id, ownerUserId, paused, actor) {
  const def = getDefinition(id, ownerUserId);
  if (!def) return null;
  db()
    .prepare(`UPDATE agent_workflow_definitions SET paused = ?, updated_at = datetime('now') WHERE id = ? AND owner_user_id = ?`)
    .run(paused ? 1 : 0, id, ownerUserId);
  if (paused) removeWorkflowSchedule(id);
  else syncWorkflowScheduleRegistry(id);
  appendAudit(id, {
    action: paused ? 'paused' : 'resumed',
    summary: paused ? `Workflow "${def.name}" paused — all triggers disabled` : `Workflow "${def.name}" resumed`,
    changedBy: actor?.id,
    changedByName: actor?.name,
  });
  return getDefinition(id, ownerUserId);
}

function syncTriggerNodeInGraph(graph, { trigger_modes, schedule_cron, chat_trigger_phrase }) {
  if (!graph?.nodes?.length) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.type === 'trigger'
        ? {
            ...n,
            data: {
              ...n.data,
              triggerModes: trigger_modes,
              scheduleCron: schedule_cron,
              chatPhrase: chat_trigger_phrase,
            },
          }
        : n
    ),
  };
}

/** Clear cron/chat when their trigger mode is disabled — prevents stale scheduled runs. */
export function normalizeTriggerSettings(triggerModesInput, scheduleCron = '', chatPhrase = '') {
  const trigger_modes = (Array.isArray(triggerModesInput) ? triggerModesInput : String(triggerModesInput || 'manual').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!trigger_modes.length) trigger_modes.push('manual');
  const schedule_cron = trigger_modes.includes('schedule') ? String(scheduleCron || '').trim() : '';
  const chat_trigger_phrase = trigger_modes.includes('chat') ? String(chatPhrase || '').trim() : '';
  return { trigger_modes, schedule_cron, chat_trigger_phrase };
}

/** DB rows where schedule_cron remains after schedule mode removed. */
export function repairStaleScheduleCrons() {
  const result = db()
    .prepare(
      `UPDATE agent_workflow_definitions
       SET schedule_cron = '', updated_at = datetime('now')
       WHERE (trigger_modes NOT LIKE '%schedule%' OR trigger_modes IS NULL)
         AND schedule_cron IS NOT NULL AND schedule_cron != ''`
    )
    .run();
  return result.changes || 0;
}

/** Apply trigger mode / schedule changes immediately on published workflow. */
export function updateTriggers(id, ownerUserId, patch, actor) {
  const def = getDefinition(id, ownerUserId);
  if (!def) return null;

  const normalized = normalizeTriggerSettings(
    patch.trigger_modes != null ? patch.trigger_modes : def.trigger_modes,
    patch.schedule_cron != null ? patch.schedule_cron : def.schedule_cron,
    patch.chat_trigger_phrase != null ? patch.chat_trigger_phrase : def.chat_trigger_phrase
  );
  const { trigger_modes, schedule_cron, chat_trigger_phrase } = normalized;

  const draftGraph = syncTriggerNodeInGraph(def.draft_graph, normalized);
  const publishedGraph = def.published_graph ? syncTriggerNodeInGraph(def.published_graph, normalized) : null;

  db()
    .prepare(
      `UPDATE agent_workflow_definitions
       SET trigger_modes = ?, schedule_cron = ?, chat_trigger_phrase = ?,
           draft_graph_json = ?, published_graph_json = COALESCE(?, published_graph_json),
           updated_at = datetime('now')
       WHERE id = ? AND owner_user_id = ?`
    )
    .run(
      trigger_modes.join(','),
      schedule_cron,
      chat_trigger_phrase,
      JSON.stringify(draftGraph),
      publishedGraph ? JSON.stringify(publishedGraph) : null,
      id,
      ownerUserId
    );

  appendAudit(id, {
    action: 'triggers_updated',
    summary: `Triggers updated: ${trigger_modes.join(', ')}${schedule_cron ? ` cron=${schedule_cron}` : ''}`,
    changedBy: actor?.id,
    changedByName: actor?.name,
    diff: { trigger_modes, schedule_cron, chat_trigger_phrase },
  });
  syncWorkflowScheduleRegistry(id);
  return getDefinition(id, ownerUserId);
}

export function isWorkflowTriggerable(def) {
  if (!def || def.paused) return false;
  if (def.status !== 'published') return false;
  return true;
}

export function findPublishedByChatPhrase(ownerUserId, message) {
  const msg = String(message || '').trim().toLowerCase();
  if (!msg) return null;
  const rows = db()
    .prepare(
      `SELECT * FROM agent_workflow_definitions
       WHERE owner_user_id = ? AND status = 'published' AND chat_trigger_phrase != ''
       AND (paused IS NULL OR paused = 0)`
    )
    .all(ownerUserId);
  for (const row of rows) {
    const phrase = String(row.chat_trigger_phrase || '').trim().toLowerCase();
    if (phrase && msg.includes(phrase)) return rowToDefinition(row);
  }
  return null;
}

export function listScheduledPublished() {
  return listScheduledFromRegistry();
}

/** Central schedule registry — sole source for the workflow scheduler tick. */
export function listScheduledFromRegistry() {
  const rows = db()
    .prepare(
      `SELECT s.definition_id, s.owner_user_id, s.schedule_cron, s.workflow_name, s.enabled,
              d.status, d.paused, d.trigger_modes, d.chat_trigger_phrase
       FROM agent_workflow_schedules s
       INNER JOIN agent_workflow_definitions d ON d.id = s.definition_id
       WHERE s.enabled = 1
         AND (d.paused IS NULL OR d.paused = 0)
         AND d.status = 'published'
         AND d.trigger_modes LIKE '%schedule%'
         AND s.schedule_cron IS NOT NULL AND s.schedule_cron != ''`
    )
    .all();
  return rows.map((row) => {
    const def = getDefinition(row.definition_id, row.owner_user_id);
    return def || rowToDefinition(db().prepare('SELECT * FROM agent_workflow_definitions WHERE id = ?').get(row.definition_id));
  }).filter(Boolean);
}

export function listScheduleRegistryRows() {
  return db()
    .prepare(
      `SELECT s.*, d.paused, d.status, d.trigger_modes
       FROM agent_workflow_schedules s
       LEFT JOIN agent_workflow_definitions d ON d.id = s.definition_id
       ORDER BY s.updated_at DESC`
    )
    .all();
}

/** Remove one workflow from the central schedule registry (pause / manual-only / delete). */
export function removeWorkflowSchedule(definitionId) {
  const result = db().prepare('DELETE FROM agent_workflow_schedules WHERE definition_id = ?').run(definitionId);
  return result.changes || 0;
}

/**
 * Rebuild central schedule registry from workflow definitions.
 * Call on backend startup and after any trigger/publish/pause change.
 */
export function syncWorkflowScheduleRegistry(definitionId = null) {
  repairStaleScheduleCrons();

  const syncOne = (id) => {
    const row = db().prepare('SELECT * FROM agent_workflow_definitions WHERE id = ?').get(id);
    if (!row) {
      removeWorkflowSchedule(id);
      return;
    }
    const def = rowToDefinition(row);
    const cronExpr = String(def.schedule_cron || '').trim();
    const shouldRegister =
      def.status === 'published' &&
      !def.paused &&
      def.trigger_modes.includes('schedule') &&
      cronExpr.length > 0;

    if (!shouldRegister) {
      removeWorkflowSchedule(id);
      return;
    }

    db()
      .prepare(
        `INSERT INTO agent_workflow_schedules (definition_id, owner_user_id, workflow_name, schedule_cron, enabled, updated_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'))
         ON CONFLICT(definition_id) DO UPDATE SET
           owner_user_id = excluded.owner_user_id,
           workflow_name = excluded.workflow_name,
           schedule_cron = excluded.schedule_cron,
           enabled = 1,
           updated_at = datetime('now')`
      )
      .run(id, def.owner_user_id, def.name, cronExpr);
  };

  if (definitionId) {
    syncOne(definitionId);
    return;
  }

  const published = db().prepare(`SELECT id FROM agent_workflow_definitions WHERE status = 'published'`).all();
  const keep = new Set();
  for (const { id } of published) {
    syncOne(id);
    const still = db().prepare('SELECT 1 FROM agent_workflow_schedules WHERE definition_id = ?').get(id);
    if (still) keep.add(id);
  }
  const allReg = db().prepare('SELECT definition_id FROM agent_workflow_schedules').all();
  for (const { definition_id } of allReg) {
    if (!keep.has(definition_id)) removeWorkflowSchedule(definition_id);
  }
}

export function isWorkflowInScheduleRegistry(definitionId) {
  const row = db()
    .prepare(
      `SELECT s.definition_id FROM agent_workflow_schedules s
       INNER JOIN agent_workflow_definitions d ON d.id = s.definition_id
       WHERE s.definition_id = ? AND s.enabled = 1
         AND (d.paused IS NULL OR d.paused = 0)
         AND d.status = 'published'
         AND d.trigger_modes LIKE '%schedule%'`
    )
    .get(definitionId);
  return !!row;
}

/** Cross-process dedupe: only one scheduled fire per workflow per minute. */
export function claimScheduleFire(definitionId, tickMinute) {
  try {
    db()
      .prepare(
        `INSERT INTO agent_workflow_schedule_ticks (definition_id, tick_minute) VALUES (?, ?)`
      )
      .run(definitionId, tickMinute);
    return true;
  } catch {
    return false;
  }
}
