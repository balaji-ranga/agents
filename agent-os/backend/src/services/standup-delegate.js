/**
 * Delegate to all agents under COO (from DB). No hardcoded agent ids.
 * Uses OpenClaw Message API (chat) to each agent; agents come from DB metadata (parent_id = COO).
 */
import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';

function db() {
  return getDb();
}

const SESSION_USER = 'agent-os-standup-delegate';

/**
 * Get all agents that report to the COO (from DB). Dynamic - any new agent with parent_id = COO is included.
 */
function getAgentsUnderCoo() {
  const coo = db().prepare('SELECT id FROM agents WHERE is_coo = 1 LIMIT 1').get();
  if (!coo) return [];
  return db()
    .prepare('SELECT id, name, role, openclaw_agent_id FROM agents WHERE parent_id = ? AND id != ?')
    .all(coo.id, coo.id);
}

/**
 * Delegate to all agents under COO. Uses each agent's name/role from DB for context.
 * @param {string} [contextFromConversation] - Optional context (e.g. last CEO message) to include in the ask
 * @returns {Promise<Array<{ agent_id: string, name: string, content: string }>>}
 */
export async function delegateToAgents(contextFromConversation = '') {
  const delegated = getAgentsUnderCoo();
  const results = [];

  for (const agent of delegated) {
    const openclawId = agent.openclaw_agent_id || 'main';
    const roleDesc = agent.role ? ` Your role: ${agent.role}.` : '';
    const prompt = contextFromConversation.trim()
      ? `The COO is requesting your update for the CEO standup.${roleDesc} Context from the standup: ${contextFromConversation.trim()}. Please provide your status and any deliverables for CEO review. Reply with actual content.`
      : `The COO is requesting your update for the CEO standup.${roleDesc} Please provide your status and any deliverables for CEO review. Reply with actual content.`;

    try {
      const { content } = await openclaw.chatCompletions(
        openclawId,
        [{ role: 'user', content: prompt }],
        openclaw.sessionUserFor(openclawId, SESSION_USER),
        false
      );
      results.push({ agent_id: agent.id, name: agent.name, content: content || '(no response)' });
    } catch (err) {
      results.push({ agent_id: agent.id, name: agent.name, content: `[Error: ${err.message}]` });
    }
  }

  return results;
}

export { getAgentsUnderCoo };
