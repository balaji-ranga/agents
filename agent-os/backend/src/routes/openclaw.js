/**
 * OpenClaw config sync: list agents from ~/.openclaw/openclaw.json and sync into agent-os DB.
 */
import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/schema.js';

const router = Router();
const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';

function getOpenClawConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH || join(USERPROFILE, '.openclaw', 'openclaw.json');
}

/**
 * GET /api/openclaw/agents
 * Returns agents from OpenClaw config and from DB so the UI can compare and sync.
 */
router.get('/agents', (req, res) => {
  try {
    const configPath = getOpenClawConfigPath();
    let openclawList = [];
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      openclawList = config?.agents?.list ?? [];
    }

    const db = getDb();
    const dbAgents = db.prepare('SELECT * FROM agents ORDER BY created_at').all();

    res.json({
      openclaw: openclawList,
      db: dbAgents,
      configPath,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/openclaw/sync
 * Body: { agent_id?: string } — if agent_id provided, sync that OpenClaw agent only; else sync all.
 * For each OpenClaw agent: upsert into agents by id (id = openclaw agent id, openclaw_agent_id = same, name/workspace from config).
 */
router.post('/sync', (req, res) => {
  try {
    const configPath = getOpenClawConfigPath();
    if (!existsSync(configPath)) {
      return res.status(400).json({ error: 'OpenClaw config not found at ' + configPath });
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const openclawList = config?.agents?.list ?? [];
    const filterId = req.body?.agent_id ? String(req.body.agent_id).trim().toLowerCase() : null;

    const toSync = filterId
      ? openclawList.filter((a) => (a.id || '').toLowerCase() === filterId)
      : openclawList;

    const db = getDb();
    const updated = [];
    for (const a of toSync) {
      const id = (a.id || '').trim() || `agent-${Date.now()}`;
      const name = (a.name || id).trim();
      const workspacePath = a.workspace ? String(a.workspace).trim() : null;

      const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
      if (existing) {
        db.prepare(
          'UPDATE agents SET name = ?, workspace_path = ?, openclaw_agent_id = ? WHERE id = ?'
        ).run(name, workspacePath, id, id);
      } else {
        db.prepare(
          `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, name, '', null, workspacePath, id, 0);
      }
      updated.push({ id, name, workspace_path: workspacePath });
    }

    res.json({ synced: updated.length, agents: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
