/**
 * Kanban board API: tasks (CRUD, filters), task messages, reopen.
 * Status flow: open | awaiting_confirmation | in_progress | completed | failed.
 * When user adds a message to a task with an assigned agent, the session continues: we call the agent and append its reply.
 */
import { Router } from 'express';
import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';
import { resolveKanbanTaskArtifacts } from '../services/kanban-artifacts.js';
import { parseAgentWorkflowMeta } from '../services/agent-workflow-kanban.js';
import { formatServerDateTime, getServerTimezone } from '../utils/format-datetime.js';
import { attachAuthUser, requireAuth } from '../middleware/auth.js';
import {
  filterKanbanTasksForUser,
  kanbanTaskBelongsToUser,
  assertKanbanTaskAccess,
} from '../services/kanban-user-scope.js';

const router = Router();
router.use(attachAuthUser);
router.use(requireAuth);
const VALID_STATUSES = ['open', 'awaiting_confirmation', 'in_progress', 'completed', 'failed'];

function db() {
  return getDb();
}

function resolveWorkflowStepIo(description) {
  const meta = parseAgentWorkflowMeta(description);
  if (!meta.run_id || !meta.node_id) return { input: null, output: null };
  const step = db()
    .prepare('SELECT input_json, output_json FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?')
    .get(meta.run_id, meta.node_id);
  if (!step) return { input: null, output: null };
  let input = null;
  let output = null;
  try {
    if (step.input_json) input = JSON.parse(step.input_json);
  } catch {
    input = { _raw: step.input_json };
  }
  try {
    if (step.output_json) output = JSON.parse(step.output_json);
  } catch {
    output = { _raw: step.output_json };
  }
  return { input, output };
}

function parseViewRange(view, from, to) {
  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);
  if (view === 'daily') {
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  } else if (view === 'weekly') {
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  } else if (view === 'monthly') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (view === 'range' && from && to) {
    start = new Date(from);
    end = new Date(to);
  } else {
    return null;
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

// GET /api/kanban/tasks — list with filters: view=daily|weekly|monthly|range, from, to
router.get('/tasks', (req, res) => {
  try {
    const view = (req.query.view || 'weekly').toLowerCase();
    const from = req.query.from;
    const to = req.query.to;
    const range = parseViewRange(view, from, to);

    let sql = `
      SELECT k.id, k.title, k.description, k.status, k.assigned_agent_id, k.created_by, k.standup_id,
             k.agent_delegation_task_id, k.created_at, k.updated_at, k.due_date,
             a.name AS assigned_agent_name
      FROM kanban_tasks k
      LEFT JOIN agents a ON a.id = k.assigned_agent_id
    `;
    const params = [];
    if (range) {
      const startSql = range.start.replace('T', ' ').replace(/\.\d{3}Z$/, '').slice(0, 19);
      const endSql = range.end.replace('T', ' ').replace(/\.\d{3}Z$/, '').slice(0, 19);
      sql += ` WHERE k.created_at >= ? AND k.created_at <= ?`;
      params.push(startSql, endSql);
    }
    sql += ` ORDER BY k.created_at DESC`;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    sql += ` LIMIT ?`;
    params.push(limit * 4);

    const rows = db().prepare(sql).all(...params);
    const scoped = filterKanbanTasksForUser(rows, req.authUser).slice(0, limit);
    const server_timezone = getServerTimezone();
    const tasks = scoped.map((row) => ({
      ...row,
      created_at_display: formatServerDateTime(row.created_at),
      updated_at_display: row.updated_at ? formatServerDateTime(row.updated_at) : null,
    }));
    res.json({ tasks, server_timezone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/kanban/summary — for standup: last 1 day task progress (counts by agent/status)
router.get('/summary', (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 1, 31);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = db()
      .prepare(
        `SELECT k.id, k.title, k.description, k.status, k.assigned_agent_id, k.created_by, k.standup_id,
                k.agent_delegation_task_id, k.created_at, k.updated_at, k.due_date,
                a.name AS assigned_agent_name
         FROM kanban_tasks k
         LEFT JOIN agents a ON a.id = k.assigned_agent_id
         WHERE k.created_at >= ? AND k.assigned_agent_id IS NOT NULL
         ORDER BY k.created_at DESC
         LIMIT ?`
      )
      .all(since, 2000);
    const scoped = filterKanbanTasksForUser(rows, req.authUser);
    const counts = {};
    for (const r of scoped) {
      if (!counts[r.assigned_agent_id]) {
        counts[r.assigned_agent_id] = { open: 0, awaiting_confirmation: 0, in_progress: 0, completed: 0, failed: 0 };
      }
      if (VALID_STATUSES.includes(r.status)) counts[r.assigned_agent_id][r.status] += 1;
    }
    const byAgent = counts;
    const agentNames = db().prepare('SELECT id, name FROM agents').all();
    const names = Object.fromEntries(agentNames.map((a) => [a.id, a.name]));
    res.json({ since, by_agent: byAgent, agent_names: names });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/kanban/tasks/:id — one task with messages and delegation context (prompt/response given to agent)
router.get('/tasks/:id', (req, res) => {
  try {
    const task = db().prepare('SELECT k.*, a.name AS assigned_agent_name FROM kanban_tasks k LEFT JOIN agents a ON a.id = k.assigned_agent_id WHERE k.id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    assertKanbanTaskAccess(task, req.authUser);
    const messages = db().prepare('SELECT id, role, content, created_at FROM task_messages WHERE task_id = ? ORDER BY created_at').all(task.id);
    let delegation_prompt = null;
    let delegation_response = null;
    if (task.agent_delegation_task_id) {
      const d = db().prepare('SELECT prompt, response_content FROM agent_delegation_tasks WHERE id = ?').get(task.agent_delegation_task_id);
      if (d) {
        delegation_prompt = d.prompt || null;
        delegation_response = d.response_content || null;
      }
    }
    const { artifacts, groups, count: artifact_count } = resolveKanbanTaskArtifacts(
      task,
      task.agent_delegation_task_id
        ? { prompt: delegation_prompt, response_content: delegation_response }
        : null,
      messages
    );
    const { input: workflow_step_input, output: workflow_step_output } = resolveWorkflowStepIo(task.description);
    res.json({
      ...task,
      created_at_display: formatServerDateTime(task.created_at),
      updated_at_display: task.updated_at ? formatServerDateTime(task.updated_at) : null,
      server_timezone: getServerTimezone(),
      messages,
      delegation_prompt,
      delegation_response,
      workflow_step_input,
      workflow_step_output,
      artifacts,
      artifact_groups: groups,
      artifact_count,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/kanban/tasks — create. Body: title, description?, assign_to: 'coo' | agent_id
router.post('/tasks', (req, res) => {
  try {
    const { title, description, assign_to, due_date } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
    const assigned_agent_id = assign_to && assign_to !== 'coo' ? String(assign_to).trim() || null : null;
    const desc = typeof description === 'string' ? description.trim() : '';
    const due = due_date ? new Date(due_date).toISOString().slice(0, 10) : null;
    db()
      .prepare(
        `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by, due_date) VALUES (?, ?, ?, ?, 'user', ?)`
      )
      .run(title.trim(), desc, assigned_agent_id ? 'awaiting_confirmation' : 'open', assigned_agent_id, due);
    const row = db().prepare('SELECT * FROM kanban_tasks ORDER BY id DESC LIMIT 1').get();
    res.status(201).json(row);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// PATCH /api/kanban/tasks/:id — update status, assigned_agent_id, etc.
router.patch('/tasks/:id', (req, res) => {
  try {
    const task = db().prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    assertKanbanTaskAccess(task, req.authUser);
    const { status, assigned_agent_id, title, description, due_date } = req.body;
    const updates = [];
    const values = [];
    if (status !== undefined && VALID_STATUSES.includes(status)) {
      updates.push('status = ?');
      values.push(status);
    }
    if (assigned_agent_id !== undefined) {
      updates.push('assigned_agent_id = ?');
      values.push(assigned_agent_id || null);
    }
    if (title !== undefined && typeof title === 'string') {
      updates.push('title = ?');
      values.push(title.trim());
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(typeof description === 'string' ? description : '');
    }
    if (due_date !== undefined) {
      updates.push('due_date = ?');
      values.push(due_date ? new Date(due_date).toISOString().slice(0, 10) : null);
    }
    if (updates.length === 0) return res.json(task);
    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);
    db().prepare(`UPDATE kanban_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const updated = db().prepare('SELECT k.*, a.name AS assigned_agent_name FROM kanban_tasks k LEFT JOIN agents a ON a.id = k.assigned_agent_id WHERE k.id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// POST /api/kanban/tasks/:id/reopen — set status to open, keep chat history
router.post('/tasks/:id/reopen', (req, res) => {
  try {
    const task = db().prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    assertKanbanTaskAccess(task, req.authUser);
    db().prepare("UPDATE kanban_tasks SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    const updated = db().prepare('SELECT k.*, a.name AS assigned_agent_name FROM kanban_tasks k LEFT JOIN agents a ON a.id = k.assigned_agent_id WHERE k.id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// DELETE /api/kanban/tasks/:id — delete one task (messages + clear FK then task)
router.delete('/tasks/:id', (req, res) => {
  try {
    const task = db().prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    assertKanbanTaskAccess(task, req.authUser);
    const id = Number(req.params.id);
    db().prepare('UPDATE kanban_tasks SET standup_id = NULL, agent_delegation_task_id = NULL WHERE id = ?').run(id);
    db().prepare('DELETE FROM task_messages WHERE task_id = ?').run(id);
    db().prepare('DELETE FROM kanban_tasks WHERE id = ?').run(id);
    res.status(204).send();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// DELETE /api/kanban/tasks — bulk delete. Body: { task_ids: [1, 2, 3] }
router.delete('/tasks', (req, res) => {
  try {
    const ids = Array.isArray(req.body?.task_ids) ? req.body.task_ids.map((n) => Number(n)).filter((n) => n > 0) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'task_ids array required with at least one id' });
    const allowed = [];
    for (const id of ids) {
      const task = db().prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(id);
      if (task && kanbanTaskBelongsToUser(task, req.authUser)) allowed.push(id);
    }
    if (!allowed.length) return res.status(404).json({ error: 'No accessible tasks found' });
    const placeholders = allowed.map(() => '?').join(',');
    db().prepare(`UPDATE kanban_tasks SET standup_id = NULL, agent_delegation_task_id = NULL WHERE id IN (${placeholders})`).run(...allowed);
    db().prepare(`DELETE FROM task_messages WHERE task_id IN (${placeholders})`).run(...allowed);
    db().prepare(`DELETE FROM kanban_tasks WHERE id IN (${placeholders})`).run(...allowed);
    res.status(204).send();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/kanban/tasks/:id/messages
router.get('/tasks/:id/messages', (req, res) => {
  try {
    const task = db().prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    assertKanbanTaskAccess(task, req.authUser);
    const rows = db().prepare('SELECT id, role, content, created_at FROM task_messages WHERE task_id = ? ORDER BY created_at').all(req.params.id);
    res.json(rows);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/kanban/tasks/:id/messages — add message (role, content). If task has assigned agent, continue session: call agent and append reply.
router.post('/tasks/:id/messages', async (req, res) => {
  try {
    const task = db().prepare('SELECT id, title, description, status, assigned_agent_id, agent_delegation_task_id FROM kanban_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    assertKanbanTaskAccess(task, req.authUser);
    const { role, content } = req.body;
    const r = (role || 'user').toString().toLowerCase();
    const c = content != null ? (typeof content === 'string' ? content : JSON.stringify(content)) : '';
    db().prepare('INSERT INTO task_messages (task_id, role, content) VALUES (?, ?, ?)').run(req.params.id, r, c);
    const userRow = db().prepare('SELECT id, role, content, created_at FROM task_messages WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(req.params.id);

    if (task.assigned_agent_id && r === 'user') {
      const agent = db().prepare('SELECT id, openclaw_agent_id FROM agents WHERE id = ?').get(task.assigned_agent_id);
      if (agent) {
        let delegationPrompt = null;
        let delegationResponse = null;
        if (task.agent_delegation_task_id) {
          const d = db().prepare('SELECT prompt, response_content FROM agent_delegation_tasks WHERE id = ?').get(task.agent_delegation_task_id);
          if (d) {
            delegationPrompt = d.prompt || null;
            delegationResponse = d.response_content || null;
          }
        }
        const taskMessages = db().prepare('SELECT role, content FROM task_messages WHERE task_id = ? ORDER BY created_at').all(req.params.id);
        const openclawAgentId = agent.openclaw_agent_id || agent.id;
        const sessionUser = `kanban-${req.params.id}`;
        const sessionKeyLine = `Your session key for this run is ${openclaw.sessionKeyFor(openclawAgentId, sessionUser)}. Use this exact sessionKey when calling sessions_history. The messages in this request already contain the full task conversation; if sessions_history returns empty, use these messages as your context and proceed.\n\n`;
        const taskId = Number(req.params.id);
        // For direct-assigned tasks (no COO delegation), inject same Kanban workflow instructions as delegation path
        const isDirectAssign = !task.agent_delegation_task_id;
        const kanbanInstructions = isDirectAssign
          ? `FIRST ACTION (before anything else): call the kanban_move_status tool with JSON:\n  {"task_id": ${taskId}, "new_status": "in_progress"}\n\n`
          : '';
        const kanbanFinishBlock = isDirectAssign
          ? `\n\n---\nIMPORTANT — Kanban finish:\nWhen you are done, call ONE of:\n  {"task_id": ${taskId}, "new_status": "completed"}\n  {"task_id": ${taskId}, "new_status": "failed"}\n---`
          : '';
        const messages = [];
        const taskContext = delegationPrompt || [task.title, task.description].filter(Boolean).join('\n') || task.title;
        messages.push({ role: 'user', content: sessionKeyLine + kanbanInstructions + `Task: ${taskContext}` + kanbanFinishBlock });
        if (delegationResponse) messages.push({ role: 'assistant', content: delegationResponse });
        for (const m of taskMessages) messages.push({ role: m.role, content: m.content });
        try {
          const { content: replyContent } = await openclaw.chatCompletions(openclawAgentId, messages, sessionUser, false);
          const reply = (replyContent && String(replyContent).trim()) || '(No reply.)';
          db().prepare('INSERT INTO task_messages (task_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'assistant', reply);
        } catch (err) {
          const errMsg = err?.message || String(err);
          db().prepare('INSERT INTO task_messages (task_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'assistant', `[Error from agent: ${errMsg}]`);
        }
      }
    }

    res.status(201).json(userRow);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

export default router;
