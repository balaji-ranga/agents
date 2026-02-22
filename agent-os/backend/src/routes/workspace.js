import { Router } from 'express';
import * as workspace from '../workspace/adapter.js';

const router = Router();

router.get('/files', async (req, res) => {
  try {
    const result = await workspace.listWorkspaceFiles();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/files/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const format = req.query.format;
    const result = await workspace.readWorkspaceFile(name);
    if (format === 'html') {
      res.type('text/html').send(`<pre>${escapeHtml(result.text)}</pre>`);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/files/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const text = typeof req.body === 'string' ? req.body : (req.body?.text ?? req.body?.content ?? '');
    const result = await workspace.writeWorkspaceFile(name, text);
    const read = await workspace.readWorkspaceFile(name);
    res.json({ ...result, text: read.text });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default router;
