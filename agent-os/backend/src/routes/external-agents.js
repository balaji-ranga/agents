/**
 * External A2A agent registry API.
 */
import { Router } from 'express';
import { requireAuth, requireCeoOrAdmin } from '../middleware/auth.js';
import {
  listExternalAgents,
  getExternalAgent,
  createExternalAgent,
  updateExternalAgent,
  deleteExternalAgent,
  discoverExternalAgent,
  invokeExternalAgent,
} from '../services/external-agents.js';

const router = Router();

router.use(requireAuth);
router.use(requireCeoOrAdmin);

router.get('/', (req, res) => {
  try {
    const forWorkflow = req.query.for_workflow === '1' || req.query.for_workflow === 'true';
    res.json({ agents: listExternalAgents(req.authUser, { forWorkflow }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const agent = createExternalAgent(req.authUser, req.body || {});
    res.status(201).json(agent);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const agent = getExternalAgent(req.params.id, req.authUser);
    if (!agent) return res.status(404).json({ error: 'External agent not found' });
    res.json(agent);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const agent = updateExternalAgent(req.params.id, req.authUser, req.body || {});
    res.json(agent);
  } catch (e) {
    res.status(e.message.includes('Not allowed') ? 403 : 400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    res.json(deleteExternalAgent(req.params.id, req.authUser));
  } catch (e) {
    res.status(e.message.includes('Not allowed') ? 403 : 400).json({ error: e.message });
  }
});

router.post('/:id/discover', async (req, res) => {
  try {
    const agent = await discoverExternalAgent(req.params.id, req.authUser);
    res.json(agent);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/invoke', async (req, res) => {
  try {
    const agent = getExternalAgent(req.params.id, req.authUser);
    if (!agent) return res.status(404).json({ error: 'External agent not found' });
    const message = String(req.body?.message || req.body?.prompt || '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });
    const out = await invokeExternalAgent(req.params.id, agent.owner_user_id, {
      message,
      skillId: req.body?.skill_id || req.body?.skillId || agent.skill_id,
      contextId: req.body?.context_id || req.body?.contextId,
      timeoutMs: req.body?.timeout_ms || req.body?.timeoutMs,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
