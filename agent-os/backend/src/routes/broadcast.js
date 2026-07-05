/**
 * Broadcast a message to one or all agents and collect replies.
 * POST /api/broadcast — body: { message: string, agent_ids?: string[] }
 * Returns: { results: [ { agent_id, name, reply?, error? } ] }
 */
import { Router } from 'express';
import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    const agentIds = Array.isArray(req.body?.agent_ids) ? req.body.agent_ids : null;
    const db = getDb();
    let agents;
    if (agentIds && agentIds.length > 0) {
      const placeholders = agentIds.map(() => '?').join(',');
      agents = db.prepare(`SELECT id, name, openclaw_agent_id FROM agents WHERE id IN (${placeholders})`).all(...agentIds);
    } else {
      agents = db.prepare('SELECT id, name, openclaw_agent_id FROM agents ORDER BY id').all();
    }
    if (agents.length === 0) {
      return res.json({ results: [] });
    }
    const broadcastId = `broadcast-${Date.now()}`;
    const messages = [{ role: 'user', content: message }];
    const results = await Promise.all(
      agents.map(async (agent) => {
        const openclawAgentId = agent.openclaw_agent_id || agent.id || 'main';
        const sessionUser = `${broadcastId}-${agent.id}`;
        const sessionKeyLine = `\n\nYour session key for this run is ${openclaw.sessionKeyFor(openclawAgentId, sessionUser)}. Use this exact sessionKey when calling sessions_history. If sessions_history returns empty, the conversation is in the messages above—proceed with those.`;
        const msgWithKey = messages[0].content + sessionKeyLine;
        try {
          const { content: reply } = await openclaw.chatCompletions(openclawAgentId, [{ role: 'user', content: msgWithKey }], sessionUser, false);
          return { agent_id: agent.id, name: agent.name || agent.id, reply };
        } catch (e) {
          return { agent_id: agent.id, name: agent.name || agent.id, error: e.message || 'Gateway error' };
        }
      })
    );
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

export default router;
