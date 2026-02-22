/**
 * Use OpenAI to classify CEO message intent and allocate a task query per agent.
 * Agent list and use cases come from the COO's AGENTS.md (passed in); no hardcoded agent list.
 * Returns { [agentId: string]: string } so each agent gets only their allocated query.
 * Requires OPENAI_API_KEY. Returns null on error (caller decides fallback).
 */

const API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o-mini';

function getApiKey() {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return null;
  return key;
}

const SYSTEM_PROMPT = `You are an intent classifier for a COO standup. You will receive:
1. A document that lists available agents and their use cases (from the COO's AGENTS.md).
2. A message from the CEO.

Your job: decide which agent(s) the message is relevant to, and for each such agent output a single task query that contains only the part of the CEO message that applies to that agent's use case. Split multi-intent messages so each agent gets only their part.

Rules:
- Output valid JSON only, no markdown or extra text.
- Use the exact Agent ID from the document as each key (lowercase, as written in the doc).
- Format: { "agent_id": "task query for that agent", ... }
- Include only agents that are relevant to the message. Omit agents that are not relevant.
- Each value must be a clear, self-contained task (one or two sentences). Do not include other agents' tasks in an agent's query.
- If the message is generic (greeting, small talk, "who are you") or not relevant to any agent in the document, output an empty object: {}.`;

/**
 * @param {string} ceoMessage - Raw message from the CEO
 * @param {string} agentsMdContent - Full content of the COO's AGENTS.md (lists agents and their use cases)
 * @returns {Promise<{ [agentId: string]: string } | null>} Map of agent_id -> task query, or null on error
 */
export async function classifyIntentAndAllocate(ceoMessage, agentsMdContent) {
  const key = getApiKey();
  if (!key) return null;

  const text = (ceoMessage || '').trim();
  if (!text) return null;

  const md = (agentsMdContent || '').trim();
  if (!md) return null;

  const model = process.env.OPENAI_INTENT_MODEL || process.env.OPENAI_COO_MODEL || DEFAULT_MODEL;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Available agents and their use cases (from AGENTS.md):\n\n${md}\n\n---\n\nCEO message to classify and split:\n\n"${text}"`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    const json = content.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(json);

    if (!parsed || typeof parsed !== 'object') return {};
    const result = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) result[String(k).trim().toLowerCase()] = v.trim();
    }
    return result;
  } catch (_) {
    return null;
  }
}
