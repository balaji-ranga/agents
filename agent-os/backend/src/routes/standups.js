import { Router } from 'express';
import { getDb } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveChatOwnerUserId } from '../services/agent-chat-scope.js';
import { listAgentResponseNotificationsForUser } from '../services/agent-response-notifications.js';
import { runCooSummarization } from '../services/coo.js';
import * as openclaw from '../gateway/openclaw.js';
import { scheduleCeoRequestViaOpenClawCron, enqueueGetWorkFromTeam, enqueueDelegationTask, postCallbackForRequestId, appendToAgentMemory, extractTaskSummaryFromPrompt, extractTaskContentFromPrompt, appendDelegationResponseToAgentChat } from '../services/delegation-queue.js';
import { isAgentWorkflowPrompt } from '../services/agent-workflow-kanban.js';
import { extractOwnerUserIdFromText } from '../services/agent-chat-scope.js';
import { getLastIntentDebug } from '../services/intent-classifier.js';

const router = Router();

function db() {
  return getDb();
}

function getCooAgent() {
  return db().prepare('SELECT id, name, openclaw_agent_id FROM agents WHERE is_coo = 1 LIMIT 1').get();
}

// List standups (latest first)
router.get('/', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const rows = db()
      .prepare(
        'SELECT id, scheduled_at, status, coo_summary, ceo_summary, source, title, outcomes, created_at FROM standups ORDER BY scheduled_at DESC LIMIT ?'
      )
      .all(limit);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// OpenClaw Gateway cron webhook: agent run finished → update task and maybe post COO callback
// Must be before /:id so "cron-callback" is not captured as id
router.post('/cron-callback', (req, res) => {
  try {
    const { standup_id, request_id, agent_id, task_id } = req.query;
    const standupId = Number(standup_id);
    const taskId = Number(task_id);
    if (!standupId || !request_id || !agent_id || !taskId) {
      return res.status(400).json({ error: 'Missing standup_id, request_id, agent_id, or task_id' });
    }
    const task = db().prepare('SELECT * FROM agent_delegation_tasks WHERE id = ?').get(taskId);
    if (!task || task.standup_id !== standupId || task.to_agent_id !== agent_id) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.status !== 'pending') {
      return res.status(200).json({ ok: true, already_processed: true });
    }
    const body = req.body || {};
    const content =
      typeof body.summary === 'string'
        ? body.summary
        : typeof body.content === 'string'
          ? body.content
          : typeof body.message === 'string'
            ? body.message
            : typeof body.text === 'string'
              ? body.text
              : body.outcome?.summary ?? body.outcome?.content ?? (body.outcome && JSON.stringify(body.outcome));
    const responseContent = (content && String(content).trim()) || '(no content)';
    const now = new Date().toISOString();
    db()
      .prepare('UPDATE agent_delegation_tasks SET status = ?, response_content = ?, completed_at = ? WHERE id = ?')
      .run('completed', responseContent, now, taskId);
    appendDelegationResponseToAgentChat(
      agent_id,
      isAgentWorkflowPrompt(task.prompt)
        ? extractTaskContentFromPrompt(task.prompt)
        : extractTaskSummaryFromPrompt(task.prompt),
      responseContent,
      extractOwnerUserIdFromText(task.prompt)
    );
    const summary = extractTaskSummaryFromPrompt(task.prompt);
    appendToAgentMemory(agent_id, summary).catch(() => {});
    postCallbackForRequestId(request_id);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Notifications: recent completed delegation tasks for the signed-in user's agents.
router.get('/notifications', requireAuth, (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const notifications = listAgentResponseNotificationsForUser(req.authUser, { limit });
    res.json({ notifications });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get one standup with responses and messages (for interactive standup). ?delegation_tasks=1 adds latest tasks.
router.get('/:id', (req, res) => {
  try {
    const standup = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    if (!standup) return res.status(404).json({ error: 'Standup not found' });
    const responses = db()
      .prepare(
        'SELECT id, agent_id, content, submitted_at FROM standup_responses WHERE standup_id = ? ORDER BY submitted_at'
      )
      .all(standup.id);
    let messages = [];
    try {
      messages = db().prepare('SELECT id, role, content, created_at FROM standup_messages WHERE standup_id = ? ORDER BY created_at').all(standup.id);
    } catch (_) {}
    const out = { ...standup, responses, messages };
    if (req.query.kanban_summary === '1') {
      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const rows = db()
          .prepare(
            `SELECT assigned_agent_id, status, COUNT(*) AS count FROM kanban_tasks
             WHERE created_at >= ? AND assigned_agent_id IS NOT NULL GROUP BY assigned_agent_id, status`
          )
          .all(since);
        const byAgent = {};
        for (const r of rows) {
          if (!byAgent[r.assigned_agent_id]) byAgent[r.assigned_agent_id] = { open: 0, awaiting_confirmation: 0, in_progress: 0, completed: 0, failed: 0 };
          if (['open', 'awaiting_confirmation', 'in_progress', 'completed', 'failed'].includes(r.status)) byAgent[r.assigned_agent_id][r.status] = r.count;
        }
        out.kanban_summary = { since, by_agent: byAgent };
      } catch (_) {}
    }
    if (req.query.delegation_tasks === '1') {
      const latest = db()
        .prepare('SELECT request_id FROM agent_delegation_tasks WHERE standup_id = ? ORDER BY id DESC LIMIT 1')
        .get(standup.id);
      if (latest) {
        out.delegation_tasks = db()
          .prepare(
            'SELECT id, to_agent_id, prompt, status FROM agent_delegation_tasks WHERE standup_id = ? AND request_id = ? ORDER BY id'
          )
          .all(standup.id, latest.request_id);
        out.delegation_request_id = latest.request_id;
      } else {
        out.delegation_tasks = [];
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create standup
router.post('/', (req, res) => {
  try {
    const { scheduled_at, status, source, title, outcomes } = req.body;
    const at = scheduled_at || new Date().toISOString();
    const src = source || 'manual';
    const titleStr = typeof title === 'string' ? title.trim() || null : null;
    const outcomesStr = typeof outcomes === 'string' ? outcomes.trim() || null : null;
    db()
      .prepare('INSERT INTO standups (scheduled_at, status, source, title, outcomes) VALUES (?, ?, ?, ?, ?)')
      .run(at, status || 'scheduled', src, titleStr, outcomesStr);
    const row = db().prepare('SELECT * FROM standups ORDER BY id DESC LIMIT 1').get();
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update standup (e.g. set coo_summary, ceo_summary, status)
router.patch('/:id', (req, res) => {
  try {
    const row = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Standup not found' });
    const { coo_summary, ceo_summary, status } = req.body;
    if (coo_summary !== undefined)
      db().prepare('UPDATE standups SET coo_summary = ? WHERE id = ?').run(coo_summary, req.params.id);
    if (ceo_summary !== undefined)
      db().prepare('UPDATE standups SET ceo_summary = ? WHERE id = ?').run(ceo_summary, req.params.id);
    if (status !== undefined) db().prepare('UPDATE standups SET status = ? WHERE id = ?').run(status, req.params.id);
    const updated = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Add response to standup
router.post('/:id/responses', (req, res) => {
  try {
    const standup = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    if (!standup) return res.status(404).json({ error: 'Standup not found' });
    const { agent_id, content } = req.body;
    if (!agent_id || content == null) return res.status(400).json({ error: 'agent_id and content required' });
    db()
      .prepare('INSERT INTO standup_responses (standup_id, agent_id, content) VALUES (?, ?, ?)')
      .run(standup.id, agent_id, typeof content === 'string' ? content : JSON.stringify(content));
    const responses = db()
      .prepare('SELECT * FROM standup_responses WHERE standup_id = ? ORDER BY submitted_at')
      .all(standup.id);
    res.status(201).json(responses);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get responses for a standup
router.get('/:id/responses', (req, res) => {
  try {
    const rows = db()
      .prepare('SELECT id, agent_id, content, submitted_at FROM standup_responses WHERE standup_id = ? ORDER BY submitted_at')
      .all(req.params.id);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get standup conversation (user/COO messages)
router.get('/:id/messages', (req, res) => {
  try {
    const standup = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    if (!standup) return res.status(404).json({ error: 'Standup not found' });
    const rows = db()
      .prepare('SELECT id, role, content, created_at FROM standup_messages WHERE standup_id = ? ORDER BY created_at')
      .all(standup.id);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Standup chat: message COO (OpenClaw) or get work from team (delegate via Message API, COO presents to CEO).
// Body: { content } for chat with COO agent, or { action: 'get_work_from_team', context?: string }
router.post('/:id/messages', requireAuth, async (req, res) => {
  try {
    const standupId = Number(req.params.id);
    const standup = db().prepare('SELECT * FROM standups WHERE id = ?').get(standupId);
    if (!standup) return res.status(404).json({ error: 'Standup not found' });

    const coo = getCooAgent();
    if (!coo) return res.status(502).json({ error: 'No COO agent in DB' });

    const { content, action, context } = req.body;
    const openclawId = coo.openclaw_agent_id || 'main';
    const ownerUserId = resolveChatOwnerUserId(req, req.body || {});
    const sessionUser = openclaw.sessionUserFor(coo.id, ownerUserId);

    if (action === 'get_work_from_team') {
      db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'user', 'Get work from team.');

      const lastUser = db().prepare('SELECT content FROM standup_messages WHERE standup_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1').get(standupId, 'user');
      const ceoRequest = (context || lastUser?.content || 'Provide your status and deliverables for the CEO standup.').trim().slice(0, 2000);
      const result = await scheduleCeoRequestViaOpenClawCron(standupId, ceoRequest);

      const cooReply = result.count === 0
        ? "You have no agents under you in the org. Reply briefly that there is no team to delegate to."
        : `I've scheduled this with ${result.agentNames.join(' and ')}. You'll see their responses here when ready.${result.pendingCount > 0 ? ' Some tasks are queued; click Check for updates to fetch responses.' : ''}`;
      db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'coo', cooReply);

      const messages = db().prepare('SELECT id, role, content, created_at FROM standup_messages WHERE standup_id = ? ORDER BY created_at').all(standupId);
      const updated = db().prepare('SELECT * FROM standups WHERE id = ?').get(standupId);
      return res.status(201).json({ standup: updated, messages, coo_reply: cooReply, request_id: result.requestId, tasks_queued: result.count });
    }

    if (action === 'request_research' && content && typeof content === 'string') {
      const researchPrompt = (content || '').trim();
      if (!researchPrompt) return res.status(400).json({ error: 'content required for request_research' });
      db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'user', `Request deep research: ${researchPrompt.slice(0, 200)}`);

      const agents = db().prepare('SELECT id, name FROM agents WHERE parent_id = (SELECT id FROM agents WHERE is_coo = 1 LIMIT 1)').all();
      const researchAgent = agents.find((a) => /research|tech/i.test(a.name || '') || /research|tech/i.test(a.id || ''));
      const toAgentId = researchAgent?.id || agents[0]?.id;
      if (!toAgentId) {
        const noAgentReply = "I don't have a research agent in the team right now. Add an agent under me to delegate deep research.";
        db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'coo', noAgentReply);
        const messages = db().prepare('SELECT id, role, content, created_at FROM standup_messages WHERE standup_id = ? ORDER BY created_at').all(standupId);
        return res.status(201).json({ standup: db().prepare('SELECT * FROM standups WHERE id = ?').get(standupId), messages, coo_reply: noAgentReply });
      }
      enqueueDelegationTask(standupId, toAgentId, `Deep research request from the CEO for the standup. Please research and provide a detailed response:\n\n${researchPrompt}`, `research-${standupId}-${Date.now()}`);

      const promptToCoo = "You've received a deep research request from the CEO. You've queued it for your research agent. Reply in one short sentence that you've delegated the research and the CEO will see the result here when it's ready.";
      const { content: cooReply } = await openclaw.chatCompletions(openclawId, [{ role: 'user', content: promptToCoo }], sessionUser, false);
      db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'coo', cooReply || "I've queued the research. You'll see the result here when it's ready.");
      const messages = db().prepare('SELECT id, role, content, created_at FROM standup_messages WHERE standup_id = ? ORDER BY created_at').all(standupId);
      return res.status(201).json({ standup: db().prepare('SELECT * FROM standups WHERE id = ?').get(standupId), messages, coo_reply: cooReply });
    }

    if (content == null || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content required, or action: get_work_from_team' });
    }

    const ceoMessage = content.trim();
    db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'user', ceoMessage);

    const result = await scheduleCeoRequestViaOpenClawCron(standupId, ceoMessage);

    if (result.count === 0) {
      // No agents allocated (generic message or no agents in AGENTS.md): COO answers directly via OpenClaw.
      const history = db().prepare('SELECT role, content FROM standup_messages WHERE standup_id = ? ORDER BY created_at ASC LIMIT 30').all(standupId);
      const openclawMessages = history.map((m) => ({
        role: m.role === 'coo' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : String(m.content),
      }));
      let cooReply;
      try {
        const out = await openclaw.chatCompletions(openclawId, openclawMessages, sessionUser, false);
        cooReply = out.content || "I'm here. How can I help?";
      } catch (err) {
        cooReply = `I'm the COO (BalServe). I coordinate the team and standups. (Gateway error: ${err.message})`;
      }
      db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'coo', cooReply);
      const messages = db().prepare('SELECT id, role, content, created_at FROM standup_messages WHERE standup_id = ? ORDER BY created_at').all(standupId);
      const updated = db().prepare('SELECT * FROM standups WHERE id = ?').get(standupId);
      const payload = { standup: updated, messages, coo_reply: cooReply };
      const intentDebug = getLastIntentDebug();
      if (intentDebug) payload.intent_debug = intentDebug;
      return res.status(201).json(payload);
    }

    const cooReply = `I've asked ${result.agentNames.join(' and ')} to look into this. You'll see their responses here when ready.${result.pendingCount > 0 ? ' Some tasks are queued; click Check for updates to fetch responses.' : ''}`;
    db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'coo', cooReply);

    const messages = db().prepare('SELECT id, role, content, created_at FROM standup_messages WHERE standup_id = ? ORDER BY created_at').all(standupId);
    const updated = db().prepare('SELECT * FROM standups WHERE id = ?').get(standupId);
    const payload = { standup: updated, messages, coo_reply: cooReply, tasks_queued: result.count, request_id: result.requestId, kanban_task_ids: result.kanbanTaskIds };
    const intentDebug = getLastIntentDebug();
    if (intentDebug) payload.intent_debug = intentDebug;
    return res.status(201).json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Approve standup (CEO approval)
router.post('/:id/approve', (req, res) => {
  try {
    const standup = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    if (!standup) return res.status(404).json({ error: 'Standup not found' });
    db().prepare('UPDATE standups SET approved_at = ?, status = ? WHERE id = ?').run(new Date().toISOString(), 'completed', standup.id);
    const updated = db().prepare('SELECT * FROM standups WHERE id = ?').get(standup.id);
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete all standups and related data (must be before /:id)
// Order: clear kanban_tasks FKs first (they reference standups and agent_delegation_tasks), then delete children of standups, then standups.
router.delete('/all', (req, res) => {
  try {
    const ids = db().prepare('SELECT id FROM standups').all().map((r) => r.id);
    if (ids.length === 0) return res.status(200).json({ deleted: 0 });
    db().prepare('UPDATE kanban_tasks SET standup_id = NULL, agent_delegation_task_id = NULL WHERE standup_id IS NOT NULL OR agent_delegation_task_id IS NOT NULL').run();
    for (const id of ids) {
      const requestIds = db().prepare('SELECT DISTINCT request_id FROM agent_delegation_tasks WHERE standup_id = ?').all(id).map((r) => r.request_id);
      for (const rid of requestIds) {
        db().prepare('DELETE FROM delegation_callbacks WHERE request_id = ?').run(rid);
      }
      db().prepare('DELETE FROM agent_delegation_tasks WHERE standup_id = ?').run(id);
      db().prepare('DELETE FROM standup_messages WHERE standup_id = ?').run(id);
      db().prepare('DELETE FROM standup_responses WHERE standup_id = ?').run(id);
    }
    db().prepare('DELETE FROM standups').run();
    res.status(200).json({ deleted: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete standup and related data
// Order: clear kanban_tasks FKs first (they reference standup_id and agent_delegation_task_id), then delete children, then standup.
router.delete('/:id', (req, res) => {
  try {
    const standup = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    if (!standup) return res.status(404).json({ error: 'Standup not found' });
    const id = standup.id;
    db().prepare('UPDATE kanban_tasks SET standup_id = NULL, agent_delegation_task_id = NULL WHERE standup_id = ? OR agent_delegation_task_id IN (SELECT id FROM agent_delegation_tasks WHERE standup_id = ?)').run(id, id);
    const requestIds = db().prepare('SELECT DISTINCT request_id FROM agent_delegation_tasks WHERE standup_id = ?').all(id).map((r) => r.request_id);
    for (const rid of requestIds) {
      db().prepare('DELETE FROM delegation_callbacks WHERE request_id = ?').run(rid);
    }
    db().prepare('DELETE FROM agent_delegation_tasks WHERE standup_id = ?').run(id);
    db().prepare('DELETE FROM standup_messages WHERE standup_id = ?').run(id);
    db().prepare('DELETE FROM standup_responses WHERE standup_id = ?').run(id);
    db().prepare('DELETE FROM standups WHERE id = ?').run(id);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run COO: generate standup summary and CEO digest via OpenAI (contextual to this standup's chat)
router.post('/:id/run-coo', async (req, res) => {
  try {
    const standup = db().prepare('SELECT * FROM standups WHERE id = ?').get(req.params.id);
    if (!standup) return res.status(404).json({ error: 'Standup not found' });

    const responses = db()
      .prepare('SELECT agent_id, content FROM standup_responses WHERE standup_id = ? ORDER BY submitted_at')
      .all(standup.id);

    const conversation = db()
      .prepare('SELECT role, content FROM standup_messages WHERE standup_id = ? ORDER BY created_at')
      .all(standup.id);

    let activities = [];
    if (req.query.include_activities === '1' || req.query.include_activities === 'true') {
      const agentIds = [...new Set(responses.map((r) => r.agent_id))];
      for (const aid of agentIds) {
        const rows = db()
          .prepare('SELECT agent_id, type, payload FROM activities WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10')
          .all(aid);
        activities.push(...rows);
      }
    }

    const { coo_summary, ceo_summary } = await runCooSummarization(responses, activities, conversation);

    db().prepare('UPDATE standups SET coo_summary = ?, ceo_summary = ?, status = ? WHERE id = ?').run(
      coo_summary,
      ceo_summary,
      'completed',
      standup.id
    );
    const updated = db().prepare('SELECT * FROM standups WHERE id = ?').get(standup.id);
    res.json(updated);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

export default router;
