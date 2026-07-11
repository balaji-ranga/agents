/**
 * Public webhook routes for event-triggered workflows (no session auth).
 */
import { Router } from 'express';
import { triggerWorkflowFromHook, verifyHookSecret } from '../services/agent-workflow-webhooks.js';

const router = Router();

router.post('/:definitionId', async (req, res) => {
  try {
    const definitionId = req.params.definitionId;
    const secret = req.headers['x-workflow-hook-secret'] || req.headers['x-webhook-secret'] || req.query.secret;
    const check = verifyHookSecret(definitionId, secret);
    if (!check.ok) return res.status(check.error === 'Workflow not found' ? 404 : 403).json({ error: check.error });

    const payload = req.body ?? {};
    const run = await triggerWorkflowFromHook(definitionId, payload, {
      actor: { id: 'hook', name: 'Webhook', type: 'system' },
    });
    res.status(202).json({ ok: true, run_id: run.id, run_number: run.run_number, status: run.status });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
