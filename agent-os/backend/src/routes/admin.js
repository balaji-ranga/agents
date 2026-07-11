import { Router } from 'express';
import { attachAuthUser, requireRole } from '../middleware/auth.js';
import {
  listUsers,
  getUserById,
  setUserEnabled,
  registerCeoUser,
  listUserAgents,
  grantUserAgent,
  revokeUserAgent,
  listAllAgentsGrouped,
  grantStandardAgents,
} from '../services/users.js';
import { getDb } from '../db/schema.js';
import { initCeoDb } from '../db/ceo-db.js';
import { usesTenantCeoDb } from '../db/ceo-db-config.js';

const router = Router();

router.use(attachAuthUser);
router.use(requireRole('admin'));

router.get('/users', (req, res) => {
  try {
    res.json({ users: listUsers() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/users', (req, res) => {
  try {
    const { email, password, name, region, mobile, role = 'ceo', db_mode, ceo_db_mode } = req.body || {};
    if (role === 'admin') {
      return res.status(400).json({ error: 'Use platform seed for admin accounts' });
    }
    const user = registerCeoUser({ email, password, name, region, mobile, db_mode, ceo_db_mode });
    res.status(201).json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/users/:userId', (req, res) => {
  try {
    const user = getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const agents = listUserAgents(req.params.userId);
    res.json({ user, agents });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/users/:userId/enabled', (req, res) => {
  try {
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 0;
    const user = setUserEnabled(req.params.userId, enabled);
    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:userId/agents/grant-standard', (req, res) => {
  try {
    if (usesTenantCeoDb(req.params.userId)) initCeoDb(req.params.userId);
    const agents = grantStandardAgents(req.params.userId);
    res.json({ user_id: req.params.userId, granted: agents });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:userId/agents/:agentId/enable', (req, res) => {
  try {
    res.json(grantUserAgent(req.params.userId, req.params.agentId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/users/:userId/agents/:agentId/disable', (req, res) => {
  try {
    res.json(revokeUserAgent(req.params.userId, req.params.agentId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/agents', (req, res) => {
  try {
    res.json(listAllAgentsGrouped());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/agents/custom', (req, res) => {
  try {
    const { id, name, role, parent_id, workspace_path, openclaw_agent_id, owner_user_id } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    getDb()
      .prepare(
        `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo, agent_type, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'custom', ?)`
      )
      .run(
        id,
        name,
        role || '',
        parent_id || null,
        workspace_path || null,
        openclaw_agent_id || id,
        owner_user_id || null
      );
    const agent = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
    res.status(201).json({ agent });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
