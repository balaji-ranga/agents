/**
 * Use OpenAPI-compliant LLM to classify CEO message intent and allocate a task query per agent.
 * Agent list and purpose come only from the COO's AGENTS.md (parsed and passed to the model).
 * No hardcoded agent IDs or intent rules. Uses config/llm.js. Override: OPENAI_INTENT_MODEL or OPENAI_COO_MODEL.
 * Returns { [agentId: string]: string } with agent_id keys as written in the document.
 * Returns null on error (caller decides fallback).
 */
import { getLlmConfig, chatCompletions } from '../config/llm.js';

function getIntentModelOverride() {
  return (process.env.OPENAI_INTENT_MODEL || process.env.OPENAI_COO_MODEL || '').trim() || undefined;
}

/**
 * Parse the agents table from COO AGENTS.md. Expects markdown table with columns Agent ID, Name, Role.
 * @param {string} md - Full AGENTS.md content
 * @returns {{ id: string, name: string, role: string }[]}
 */
function parseAgentsFromAgentsMd(md) {
  const agents = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || !line.includes('|')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 4) continue;
    const rawId = (parts[1] || '').replace(/\*+/g, '').trim();
    const name = (parts[2] || '').trim();
    const role = (parts[3] || '').trim();
    if (!rawId || rawId.toLowerCase() === 'agent id') continue;
    if (/^[-–—\s]+$/.test(rawId) || /^[-–—\s]+$/.test(name)) continue;
    const id = rawId.toLowerCase();
    agents.push({ id, name, role });
  }
  return agents;
}

/**
 * Build the list of agents and their purpose from parsed AGENTS.md for the model.
 * @param {{ id: string, name: string, role: string }[]} agents
 * @returns {string}
 */
function formatAgentsPurposeForModel(agents) {
  return agents
    .map((a) => `- Agent ID: "${a.id}", Name: ${a.name}, Purpose: ${a.role}`)
    .join('\n');
}

/**
 * Normalize model output keys to agent IDs from the document (so spelling/name variants map to doc id).
 * @param {Record<string, string>} parsed - model output with lowercase keys
 * @param {{ id: string, name: string, role: string }[]} agentsFromDoc
 * @returns {Record<string, string>}
 */
function normalizeKeysToDocIds(parsed, agentsFromDoc) {
  const idByKey = new Map();
  for (const a of agentsFromDoc) {
    idByKey.set(a.id.toLowerCase(), a.id);
    const nameKey = (a.name || '').toLowerCase().replace(/\s+/g, '');
    if (nameKey) idByKey.set(nameKey, a.id);
  }
  const result = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const key = String(k).trim().toLowerCase().replace(/\s+/g, '');
    const canonical = idByKey.get(key) ?? idByKey.get(String(k).trim().toLowerCase()) ?? key;
    result[canonical] = v.trim();
  }
  return result;
}

/**
 * Extract a JSON object from model output that may contain markdown, prefixes, or trailing text.
 * Tries: strip markdown code fence, then find first { and matching } by brace count.
 * @param {string} raw - Raw model response
 * @returns {object | null} Parsed object or null
 */
function extractJsonFromModelResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip markdown code block
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/g, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const jsonStr = s.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

const SYSTEM_PROMPT = `You are an intent classifier for a COO standup. You will receive:
1. A list of agents and their purpose (parsed from the COO's AGENTS.md).
2. A message from the CEO.

Your job: Map the CEO message to the right agent(s). For each agent that is relevant, output ONE key-value pair where the key is the exact Agent ID from the list and the value is ONLY the part of the CEO message that applies to that agent (redacted, context-specific). In multi-intent messages, split so each agent gets only their part—do not send the full message to every agent.

Critical:
- If the CEO message explicitly names an agent (by Agent ID or Name from the list, e.g. "TechResearcher, ..." or "ask ExpenseManager to ..."), classify the intent to that named agent. Use the full message or the part after the agent name as that agent's task; map the name to the exact Agent ID from the list (e.g. TechResearcher -> techresearcher, ExpenseManager -> expensemanager). Do not assign the same message to other agents unless the message clearly addresses multiple named agents or has multiple distinct intents.
- Each value must be the redacted, context-specific message for that agent only. Example: if the CEO says "Create an indian recipe with image and I need deep research on space science", then map techresearcher to only the research part ("I need deep research on space science") and the cuisine agent to only the cuisine part ("Create an indian recipe with image"). Do not give the full sentence to both.
- Include only agents whose purpose matches some part of the message, or that are explicitly named in the message. Omit agents that are not relevant and not named.
- Do not assign to the CEO (e.g. bala). Only delegate to agents that report to the COO.
- Output valid JSON only, no markdown or extra text. Use the exact Agent ID from the list as each key (e.g. techresearcher, expensemanager, socialasstant). Do not add explanation before or after the JSON.
- Format: { "agent_id": "redacted task query for that agent only", ... }
- For deep research, tech research, or space/science research requests, assign ONLY to the agent whose purpose is research (e.g. techresearcher). Do not assign the same message to multiple agents unless the message clearly has multiple distinct intents (e.g. research + expenses).
- If the message is generic (greeting, small talk, "who are you") or not relevant to any agent, output an empty object: {}.
- You may receive recent user messages and agent responses as additional context. Use them to resolve follow-ups (e.g. "yes do that", "tell me more", "send that to TechResearcher") by mapping to the agent that was last addressed or last responded, or to the named agent.`;

/** True if the CEO message clearly indicates a research-only request (so we can map to techresearcher when model returns {}). */
function isClearlyResearchRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase().trim();
  return /deep\s+research|research\s+on|do\s+(a\s+)?research|tech\s+research|space\s+tech|science\s+research/.test(t) && !/expense|investment|facebook|social|recipe|cuisine/.test(t);
}

/** When DEBUG_INTENT=1, last run's input and output (for API to return in response). */
let lastIntentDebug = null;

export function getLastIntentDebug() {
  return lastIntentDebug;
}

/**
 * @param {string} ceoMessage - Raw message from the CEO
 * @param {string} agentsMdContent - Full content of the COO's AGENTS.md (lists agents and their use cases)
 * @param {{ lastUserMessages?: string[], agentResponses?: { agent_id: string, content: string }[] }} [context] - Optional: recent user messages and agent responses for follow-up resolution
 * @returns {Promise<{ [agentId: string]: string } | null>} Map of agent_id -> task query, or null on error
 */
export async function classifyIntentAndAllocate(ceoMessage, agentsMdContent, context = undefined) {
  const cfg = getLlmConfig();
  const apiKey = cfg.primary?.apiKey || cfg.secondary?.apiKey;
  if (!apiKey) {
    lastIntentDebug = { systemPrompt: SYSTEM_PROMPT, userMessage: '(CEO message: ' + (ceoMessage || '').slice(0, 100) + ')', modelRawResponse: null, finalMapping: {}, error: 'No LLM API key (OPENAI_API_KEY or OPENAI_PRIMARY_API_KEY)' };
    return null;
  }

  const text = (ceoMessage || '').trim();
  if (!text) return null;

  const md = (agentsMdContent || '').trim();
  if (!md) {
    lastIntentDebug = { systemPrompt: SYSTEM_PROMPT, userMessage: '(COO AGENTS.md empty or unreadable)', modelRawResponse: null, finalMapping: {}, error: 'No AGENTS.md content' };
    return null;
  }

  const agentsFromDoc = parseAgentsFromAgentsMd(md);
  const agentsPurposeText = formatAgentsPurposeForModel(agentsFromDoc);
  if (!agentsPurposeText) {
    if (process.env.DEBUG_INTENT === '1') console.warn('[intent] No agents table parsed from AGENTS.md');
    lastIntentDebug = { systemPrompt: SYSTEM_PROMPT, userMessage: '(No agents table parsed from AGENTS.md)', modelRawResponse: null, finalMapping: {}, error: 'No agents parsed' };
    return {};
  }

  let userContent = `Agents and their purpose (from COO AGENTS.md):\n\n${agentsPurposeText}\n\n---\n\n`;
  if (context?.lastUserMessages?.length) {
    const recent = context.lastUserMessages.slice(-8).map((m) => (typeof m === 'string' ? m : String(m)).trim().slice(0, 300)).filter(Boolean);
    if (recent.length) userContent += `Recent user messages (for context; newest last):\n${recent.map((m, i) => `${i + 1}. "${m}"`).join('\n')}\n\n---\n\n`;
  }
  if (context?.agentResponses?.length) {
    const responses = context.agentResponses.slice(-10).map((r) => `- ${r.agent_id}: ${(r.content || '').trim().slice(0, 250)}`).filter((s) => s.length > 5);
    if (responses.length) userContent += `Recent agent responses (for context):\n${responses.join('\n')}\n\n---\n\n`;
  }
  userContent += `Current CEO message to classify and split:\n\n"${text}"`;

  lastIntentDebug = { systemPrompt: SYSTEM_PROMPT, userMessage: userContent, modelRawResponse: null, finalMapping: null, error: null };
  if (process.env.DEBUG_INTENT === '1') {
    console.warn('\n[intent] === SYSTEM PROMPT ===\n' + SYSTEM_PROMPT + '\n[intent] === END SYSTEM PROMPT ===');
    console.warn('\n[intent] === USER MESSAGE (to intent model) ===\n' + userContent + '\n[intent] === END USER MESSAGE ===');
  }

  try {
    const { content } = await chatCompletions({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      modelOverride: getIntentModelOverride(),
      maxTokens: 512,
    });

    const raw = (content ?? '').trim();

    if (lastIntentDebug) lastIntentDebug.modelRawResponse = raw;
    if (process.env.DEBUG_INTENT === '1') console.warn('\n[intent] === MODEL RAW RESPONSE ===\n' + raw + '\n[intent] === END MODEL RESPONSE ===');

    const parsed = extractJsonFromModelResponse(raw);
    if (!parsed || typeof parsed !== 'object') {
      if (lastIntentDebug) lastIntentDebug.error = 'Could not parse JSON from model response';
      // Apply research fallback so we don't send to all agents
      if (agentsFromDoc.some((a) => a.id === 'techresearcher') && isClearlyResearchRequest(text)) {
        if (lastIntentDebug) lastIntentDebug.finalMapping = { techresearcher: text };
        return { techresearcher: text };
      }
      if (lastIntentDebug) lastIntentDebug.finalMapping = {};
      return {};
    }
    const withLowerKeys = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) withLowerKeys[String(k).trim().toLowerCase()] = v.trim();
    }
    let result = normalizeKeysToDocIds(withLowerKeys, agentsFromDoc);
    // When model returns {} for a clearly research-only message, map only to techresearcher so we don't fall back to "all agents"
    const hasTechResearcher = agentsFromDoc.some((a) => a.id === 'techresearcher');
    if (Object.keys(result).length === 0 && hasTechResearcher && isClearlyResearchRequest(text)) {
      result = { techresearcher: text };
      if (lastIntentDebug) lastIntentDebug.finalMapping = result;
    }
    if (lastIntentDebug) lastIntentDebug.finalMapping = result;
    if (process.env.DEBUG_INTENT === '1') console.warn('[intent] Final mapping (agent_id -> message):', JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (lastIntentDebug) lastIntentDebug.error = errMsg;
    if (process.env.DEBUG_INTENT === '1') console.warn('[intent] Error:', errMsg, e.stack);
    // For clearly research-only messages, avoid fallback to "all agents" by returning techresearcher only
    if (agentsFromDoc?.some((a) => a.id === 'techresearcher') && isClearlyResearchRequest(text)) {
      if (lastIntentDebug) lastIntentDebug.finalMapping = { techresearcher: text };
      return { techresearcher: text };
    }
    return null;
  }
}
