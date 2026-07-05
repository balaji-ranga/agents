/**
 * COO summarization: call OpenAPI-compliant LLM to produce standup summary and CEO digest.
 * Uses config/llm.js: OPENAI_BASE_URL (or OPENAI_API_URL), OPENAI_PRIMARY_MODEL, OPENAI_SECONDARY_MODEL.
 * Override for COO: OPENAI_COO_MODEL. Requires OPENAI_API_KEY in env.
 */
import { chatCompletions } from '../config/llm.js';

const COO_MODEL_OVERRIDE = process.env.OPENAI_COO_MODEL || null;

/**
 * @param {Array<{ agent_id: string, content: string }>} responses - standup responses
 * @param {Array<{ agent_id: string, type: string, payload: string }>} [activities] - optional recent activities
 * @param {Array<{ role: string, content: string }>} [conversation] - optional standup chat (user/COO messages) for context
 * @returns {Promise<{ coo_summary: string, ceo_summary: string }>}
 */
export async function runCooSummarization(responses, activities = [], conversation = []) {
  const userContent = buildPrompt(responses, activities, conversation);
  const messages = [
    {
      role: 'system',
      content: `You are the COO for an agent operating system. You will be given (1) the conversation in this standup chat (CEO and COO messages), and (2) standup responses from agents. Produce exactly two short sections that are specific to this standup session:

1. **COO summary** — 2–4 sentences: what was discussed in this standup, what each agent reported, any blockers or decisions.
2. **CEO summary** — One short paragraph for the CEO: key takeaways from this standup, one thing to watch, any approval needed.

Base your summary on this standup's conversation and agent responses only. Keep tone professional and concise. Output only the two sections with headers "COO summary:" and "CEO summary:" so they can be parsed.`,
    },
    { role: 'user', content: userContent },
  ];

  const { content: text } = await chatCompletions({
    messages,
    modelOverride: COO_MODEL_OVERRIDE || undefined,
    maxTokens: 1024,
  });
  return parseCooOutput(text);
}

function buildPrompt(responses, activities, conversation = []) {
  let out = '';
  if (conversation.length > 0) {
    out += 'Conversation in this standup (CEO ↔ COO):\n\n';
    for (const m of conversation) {
      out += `${m.role === 'coo' ? 'COO' : 'CEO'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}\n\n`;
    }
    out += '---\n\n';
  }
  out += 'Standup responses from agents:\n\n';
  for (const r of responses) {
    out += `Agent ${r.agent_id}:\n${typeof r.content === 'string' ? r.content : JSON.stringify(r.content)}\n\n`;
  }
  if (responses.length === 0) out += '(No agent responses yet.)\n\n';
  if (activities.length > 0) {
    out += 'Recent activities (optional context):\n\n';
    for (const a of activities.slice(0, 20)) {
      out += `[${a.agent_id}] ${a.type}: ${typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload)}\n`;
    }
  }
  return out.trim();
}

function parseCooOutput(text) {
  let coo_summary = '';
  let ceo_summary = '';
  const cooMatch = text.match(/(?:COO summary:?|## COO summary)\s*([\s\S]*?)(?=CEO summary:|## CEO summary|$)/i);
  const ceoMatch = text.match(/(?:CEO summary:?|## CEO summary)\s*([\s\S]*?)$/im);
  if (cooMatch) coo_summary = cooMatch[1].trim();
  if (ceoMatch) ceo_summary = ceoMatch[1].trim();
  if (!coo_summary && !ceo_summary) {
    coo_summary = text.slice(0, 1500);
    ceo_summary = text.slice(1500).trim() || coo_summary;
  }
  return { coo_summary, ceo_summary };
}

/**
 * Interactive standup: COO presents agent work for CEO review and asks for approval and today's topics/tasks.
 * @param {Array<{ role: string, content: string }>} conversation - prior messages (user, coo, ...)
 * @param {Array<{ agent_id: string, content: string }>} agentResponses - work from agents (actual content)
 * @param {Record<string, string>} [agentNames] - optional map agent_id -> name for display
 * @returns {Promise<string>} COO reply to show to CEO
 */
export async function runCooInteractiveStandup(conversation, agentResponses = [], agentNames = {}) {
  let userContent = '';
  if (conversation.length > 0) {
    userContent = 'Conversation so far:\n' + conversation.map((m) => `${m.role}: ${m.content}`).join('\n\n') + '\n\n';
  }
  userContent += 'Agent work for CEO review (actual content from each agent):\n\n';
  for (const r of agentResponses) {
    const name = agentNames[r.agent_id] || r.agent_id;
    userContent += `--- ${name} ---\n${typeof r.content === 'string' ? r.content : JSON.stringify(r.content)}\n\n`;
  }
  if (agentResponses.length === 0) userContent += '(No agent work yet.)\n';

  const systemPrompt = `You are the COO in a daily standup with the CEO (Bala). Your job is to:
1. Present the work from each agent above with their actual content so the CEO can review it.
2. Ask the CEO to review and approve (or request changes).
3. Then ask: "What are today's research topics and finance tasks you'd like me to delegate to the team?" so the CEO can set the next topics and tasks.

Be concise and conversational. Address the CEO directly. If there is no agent work yet, welcome them to the standup and ask for their research topics and finance tasks to delegate.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const { content } = await chatCompletions({
    messages,
    modelOverride: COO_MODEL_OVERRIDE || undefined,
    maxTokens: 1024,
  });
  return (content ?? '').trim() || 'Standup updated. What would you like to delegate today?';
}
