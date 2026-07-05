/**
 * Delegate to all agents under COO (from DB). No hardcoded agent ids.
 * Uses OpenClaw Message API (chat) to each agent; agents come from DB metadata (parent_id = COO).
 * Wraps prompts with session history + MEMORY instruction so agents get context before responding.
 */
import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';
import { getPromptWithMemoryInjected } from './delegation-queue.js';

function db() {
  return getDb();
}

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

  const runId = `standup-delegate-${Date.now()}`;
  for (const agent of delegated) {
    const openclawId = agent.openclaw_agent_id || 'main';
    const sessionUser = `${runId}-${agent.id}`;
    const sessionKeyLine = `\n\nYour session key for this run is ${openclaw.sessionKeyFor(openclawId, sessionUser)}. Use this exact sessionKey when calling sessions_history. If sessions_history returns empty, the conversation is in the messages above—proceed with those.`;
    const roleDesc = agent.role ? ` Your role: ${agent.role}.` : '';
    const basePrompt = contextFromConversation.trim()
      ? `The COO is requesting your update for the CEO standup.${roleDesc} Context from the standup: ${contextFromConversation.trim()}. Please provide your status and any deliverables for CEO review. Reply with actual content.`
      : `The COO is requesting your update for the CEO standup.${roleDesc} Please provide your status and any deliverables for CEO review. Reply with actual content.`;
    let prompt = await getPromptWithMemoryInjected(agent.id, basePrompt);
    prompt = prompt + sessionKeyLine;

    try {
      const { content } = await openclaw.chatCompletions(
        openclawId,
        [{ role: 'user', content: prompt }],
        sessionUser,
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
