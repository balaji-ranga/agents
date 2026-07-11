/**
 * Custom script registry API — LangGraph / Python / JS scripts for workflows and brain.
 */
import { Router } from 'express';
import { requireAuth, requireCeoOrAdmin } from '../middleware/auth.js';
import {
  listCustomScripts,
  getCustomScript,
  createCustomScript,
  updateCustomScript,
  deleteCustomScript,
  scanCustomScriptDraft,
  scanCustomScriptDraftFull,
  executeCustomScript,
} from '../services/custom-scripts.js';

const router = Router();

router.use(requireAuth);
router.use(requireCeoOrAdmin);

router.get('/', (req, res) => {
  try {
    const forWorkflow = req.query.for_workflow === '1' || req.query.for_workflow === 'true';
    const scripts = listCustomScripts(req.authUser, { forWorkflow });
    res.json({ scripts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/scan', async (req, res) => {
  try {
    const full = req.query.full === '1' || req.query.full === 'true' || req.body?.full === true;
    const scan = full
      ? await scanCustomScriptDraftFull(req.body || {})
      : scanCustomScriptDraft(req.body || {});
    res.json(scan);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const script = await createCustomScript(req.authUser, req.body || {});
    res.status(201).json(script);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const includeSource = req.query.include_source === '1' || req.query.include_source === 'true';
    const script = getCustomScript(req.params.id, req.authUser, { includeSource });
    if (!script) return res.status(404).json({ error: 'Script not found' });
    res.json(script);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const script = await updateCustomScript(req.params.id, req.authUser, req.body || {});
    res.json(script);
  } catch (e) {
    res.status(e.message.includes('Not allowed') ? 403 : 400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = deleteCustomScript(req.params.id, req.authUser);
    res.json(result);
  } catch (e) {
    res.status(e.message.includes('Not allowed') ? 403 : 400).json({ error: e.message });
  }
});

router.post('/:id/execute', async (req, res) => {
  try {
    const result = await executeCustomScript(req.params.id, req.authUser, {
      inputs: req.body?.inputs || {},
      context: req.body?.context || {},
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
