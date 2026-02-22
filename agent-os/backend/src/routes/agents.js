import { Router } from 'express';
import { join } from 'path';
import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';
import * as workspace from '../workspace/adapter.js';

const router = Router();
const homedir = process.env.USERPROFILE || process.env.HOME || '';

function db() {
  return getDb();
}

function getAgentWorkspaceRoot(agent) {
  const raw = agent.workspace_path || process.env.OPENCLAW_WORKSPACE_PATH || process.env.OPENCLAW_WORKSPACE;
  if (!raw) throw new Error('No workspace path for agent and OPENCLAW_WORKSPACE_PATH not set');
  const path = String(raw).trim();
  if (path.startsWith('~')) return join(homedir, path.slice(1).replace(/^[/\\]/, '') || '');
  return path;
}

router.get('/', (req, res) => {
  try {
    const rows = db().prepare('SELECT * FROM agents ORDER BY created_at').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const row = db().prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Agent not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-agent workspace (MD files)
router.get('/:id/workspace/files', async (req, res) => {
  try {
    const agent = db().prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const root = getAgentWorkspaceRoot(agent);
    const result = await workspace.listWorkspaceFiles(root);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/workspace/files/:name', async (req, res) => {
  try {
    const agent = db().prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const root = getAgentWorkspaceRoot(agent);
    const result = await workspace.readWorkspaceFile(req.params.name, { workspaceRoot: root });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/workspace/files/:name', async (req, res) => {
  try {
    const agent = db().prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const root = getAgentWorkspaceRoot(agent);
    const text = typeof req.body === 'string' ? req.body : (req.body?.text ?? req.body?.content ?? '');
    await workspace.writeWorkspaceFile(req.params.name, text, { workspaceRoot: root });
    const read = await workspace.readWorkspaceFile(req.params.name, { workspaceRoot: root });
    res.json({ path: read.path, text: read.text });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo } = req.body;
    const agentId = id || `agent-${Date.now()}`;
    db().prepare(
      `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId,
      name || 'Unnamed',
      role || '',
      parent_id || null,
      workspace_path || null,
      openclaw_agent_id || 'main',
      is_coo ? 1 : 0
    );
    const row = db().prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = db().prepare('SELECT * FROM agents WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Agent not found' });
    const updates = req.body;
    const allowed = ['name', 'role', 'parent_id', 'workspace_path', 'openclaw_agent_id', 'is_coo'];
    const set = [];
    const values = [];
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        set.push(`${k} = ?`);
        values.push(k === 'is_coo' ? (updates[k] ? 1 : 0) : updates[k]);
      }
    }
    if (set.length) {
      db().prepare(`UPDATE agents SET ${set.join(', ')} WHERE id = ?`).run(...values, id);
    }
    const updated = db().prepare('SELECT * FROM agents WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const r = db().prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Agent not found' });
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat: get recent turns for an agent
router.get('/:id/chat', (req, res) => {
  try {
    const turns = db().prepare('SELECT id, role, content, created_at FROM chat_turns WHERE agent_id = ? ORDER BY created_at')
      .all(req.params.id);
    res.json(turns);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat: send message and get reply (OpenClaw gateway)
router.post('/:id/chat', async (req, res) => {
  try {
    const agentId = req.params.id;
    const agent = db().prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const message = typeof req.body?.message === 'string' ? req.body.message : (req.body?.content ?? req.body?.text ?? '');
    if (!message.trim()) return res.status(400).json({ error: 'message is required' });

    const userId = req.body?.user_id || req.headers['x-user-id'] || 'default';
    const openclawAgentId = agent.openclaw_agent_id || 'main';

    // Load recent history from DB for context (last N turns)
    const history = db().prepare('SELECT role, content FROM chat_turns WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(agentId)
      .reverse();
    const messages = history.map((t) => ({ role: t.role, content: t.content }));
    messages.push({ role: 'user', content: message });

    const sessionUser = openclaw.sessionUserFor(agentId, userId);
    const { content: reply, usage } = await openclaw.chatCompletions(openclawAgentId, messages, sessionUser, false);

    // Persist user message and assistant reply
    db().prepare('INSERT INTO chat_turns (agent_id, role, content) VALUES (?, ?, ?)').run(agentId, 'user', message);
    db().prepare('INSERT INTO chat_turns (agent_id, role, content) VALUES (?, ?, ?)').run(agentId, 'assistant', reply);

    res.json({ reply, usage, agent_id: agentId });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Chat from another agent (e.g. COO messages TechResearcher). Body: { from_agent_id, message }
router.post('/:id/chat/from-agent', async (req, res) => {
  try {
    const agentId = req.params.id;
    const agent = db().prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const fromAgentId = req.body?.from_agent_id;
    const message = typeof req.body?.message === 'string' ? req.body.message : (req.body?.content ?? '');
    if (!fromAgentId || !message.trim()) return res.status(400).json({ error: 'from_agent_id and message required' });

    const fromAgent = db().prepare('SELECT * FROM agents WHERE id = ?').get(fromAgentId);
    if (!fromAgent) return res.status(404).json({ error: 'From agent not found' });

    const userContent = `From ${fromAgent.name} (${fromAgent.role}): ${message.trim()}`;
    const userId = req.body?.user_id || req.headers['x-user-id'] || 'agent-os-internal';
    const openclawAgentId = agent.openclaw_agent_id || 'main';

    const history = db().prepare('SELECT role, content FROM chat_turns WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(agentId)
      .reverse();
    const messages = history.map((t) => ({ role: t.role, content: t.content }));
    messages.push({ role: 'user', content: userContent });

    const sessionUser = openclaw.sessionUserFor(agentId, userId);
    const { content: reply, usage } = await openclaw.chatCompletions(openclawAgentId, messages, sessionUser, false);

    db().prepare('INSERT INTO chat_turns (agent_id, role, content) VALUES (?, ?, ?)').run(agentId, 'user', userContent);
    db().prepare('INSERT INTO chat_turns (agent_id, role, content) VALUES (?, ?, ?)').run(agentId, 'assistant', reply);

    res.json({ reply, usage, agent_id: agentId, from_agent_id: fromAgentId });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Activities (append-only)
router.get('/:id/activities', (req, res) => {
  try {
    const rows = db().prepare('SELECT * FROM activities WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(req.params.id);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/activities', (req, res) => {
  try {
    const agentId = req.params.id;
    const agent = db().prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { type, payload } = req.body;
    db().prepare('INSERT INTO activities (agent_id, type, payload) VALUES (?, ?, ?)').run(
      agentId,
      type || 'activity',
      typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
