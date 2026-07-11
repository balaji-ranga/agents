/**
 * MCP integration registry API.
 */
import { Router } from 'express';
import { requireAuth, requireCeoOrAdmin } from '../middleware/auth.js';
import {
  listVisibleMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  connectMcpServer,
  callMcpServerTool,
  listMcpCallLogs,
  listMcpServersForWorkflow,
} from '../services/mcp-servers.js';

const router = Router();

router.use(requireAuth);
router.use(requireCeoOrAdmin);

router.get('/', (req, res) => {
  try {
    const forWorkflow = req.query.for_workflow === '1' || req.query.for_workflow === 'true';
    const servers = forWorkflow
      ? listMcpServersForWorkflow(req.authUser)
      : listVisibleMcpServers(req.authUser);
    res.json({ servers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const server = createMcpServer(req.authUser, req.body || {});
    res.status(201).json(server);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const server = getMcpServer(req.params.id, req.authUser);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });
    res.json(server);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const server = updateMcpServer(req.params.id, req.authUser, req.body || {});
    res.json(server);
  } catch (e) {
    res.status(e.message.includes('Not allowed') ? 403 : 400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = deleteMcpServer(req.params.id, req.authUser);
    res.json(result);
  } catch (e) {
    res.status(e.message.includes('Not allowed') ? 403 : 400).json({ error: e.message });
  }
});

router.post('/:id/connect', async (req, res) => {
  try {
    const auth = req.body?.auth || null;
    const result = await connectMcpServer(req.params.id, req.authUser, auth);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/tools/:toolName/call', async (req, res) => {
  try {
    const auth = req.body?.auth || null;
    const result = await callMcpServerTool(
      req.params.id,
      req.params.toolName,
      req.body?.arguments || req.body?.args || {},
      req.authUser,
      auth
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/logs', (req, res) => {
  try {
    const logs = listMcpCallLogs(req.params.id, req.authUser, Number(req.query.limit) || 20);
    res.json({ logs });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
