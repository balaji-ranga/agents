/**
 * A2A (Agent-to-Agent) protocol client — JSON-RPC over HTTP.
 * @see https://a2a-protocol.org/
 */
import { randomUUID } from 'crypto';

const A2A_METHODS = {
  send: ['message/send', 'SendMessage'],
  getTask: ['tasks/get', 'GetTask'],
};

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/$/, '');
  const p = String(path || '').replace(/^\//, '');
  return `${b}/${p}`;
}

function isDirectCardUrl(raw) {
  return (
    raw.includes('agent-card.json') ||
    raw.includes('agent.json') ||
    /\.json(\?|$)/i.test(raw)
  );
}

function cardUrlCandidates(cardUrlOrBase) {
  const raw = String(cardUrlOrBase || '').trim();
  if (!raw) return [];
  if (isDirectCardUrl(raw)) return [raw];
  const base = raw.replace(/\/$/, '');
  return [`${base}/.well-known/agent-card.json`, `${base}/.well-known/agent.json`];
}

/** Resolve agent card URL from base URL or explicit card URL. */
export function resolveAgentCardUrl(cardUrlOrBase) {
  const raw = String(cardUrlOrBase || '').trim();
  if (!raw) throw new Error('Agent card URL or base URL is required');
  return cardUrlCandidates(raw)[0];
}

async function fetchAgentCardFromUrl(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Agent card fetch failed (${res.status}): ${text.slice(0, 300)}`);
  const card = parseJsonSafe(text);
  if (!card || typeof card !== 'object') throw new Error('Invalid agent card JSON');
  return { card, cardUrl: url };
}

export async function fetchAgentCard(cardUrlOrBase, { headers = {}, timeoutMs = 15000 } = {}) {
  const candidates = cardUrlCandidates(cardUrlOrBase);
  if (!candidates.length) throw new Error('Agent card URL or base URL is required');

  let lastErr;
  for (const url of candidates) {
    try {
      return await fetchAgentCardFromUrl(url, { headers, timeoutMs });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not fetch agent card from any well-known path');
}

function pickEndpoint(card, explicitEndpoint) {
  if (explicitEndpoint) return String(explicitEndpoint).trim();
  if (card.url) return String(card.url).trim();
  const iface = Array.isArray(card.interfaces) ? card.interfaces[0] : null;
  if (iface?.url) return String(iface.url).trim();
  throw new Error('No A2A endpoint URL in agent card or config');
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      if (!p || typeof p !== 'object') return '';
      if (p.kind === 'text' || p.type === 'text') return String(p.text || p.content || '');
      if (typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function extractA2AResponseText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const result = payload.result ?? payload;
  if (result?.parts) return extractTextFromParts(result.parts);
  if (result?.kind === 'message' && Array.isArray(result.parts)) {
    return extractTextFromParts(result.parts);
  }
  const task = result.task ?? result;
  const message = task.message ?? result.message ?? task.status?.message;
  if (message?.parts) return extractTextFromParts(message.parts);
  if (Array.isArray(task.artifacts)) {
    return task.artifacts
      .flatMap((a) => (Array.isArray(a.parts) ? a.parts : []))
      .map((p) => extractTextFromParts([p]))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof result.text === 'string') return result.text;
  if (typeof task.text === 'string') return task.text;
  return '';
}

export function extractA2ATaskId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const result = payload.result ?? payload;
  const task = result.task ?? result;
  return task.id || task.taskId || result.taskId || null;
}

export function extractA2ATaskState(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const result = payload.result ?? payload;
  const task = result.task ?? result;
  const state = task.status?.state ?? task.state ?? task.status;
  return typeof state === 'string' ? state.toLowerCase() : null;
}

const TERMINAL_TASK_STATES = new Set([
  'completed',
  'complete',
  'failed',
  'canceled',
  'cancelled',
  'rejected',
  'input_required',
]);

export function isTerminalTaskState(state) {
  if (!state) return false;
  return TERMINAL_TASK_STATES.has(String(state).toLowerCase());
}

async function jsonRpcCall(endpointUrl, method, params, { headers = {}, timeoutMs = 90000 } = {}) {
  const body = { jsonrpc: '2.0', id: randomUUID(), method, params };
  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const data = parseJsonSafe(text);
  if (!res.ok) {
    throw new Error(`A2A HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (data?.error) {
    throw new Error(formatA2AError(data.error, text));
  }
  return data;
}

function formatA2AError(error, rawText = '') {
  const msg = error?.message || 'A2A request failed';
  const details = Array.isArray(error?.data) ? error.data : [];
  const missingMessageId = details.some((d) =>
    Array.isArray(d?.loc) ? d.loc.includes('messageId') : String(d?.msg || '').includes('messageId')
  );
  if (missingMessageId || /payload validation/i.test(msg)) {
    return `${msg} — A2A message must include messageId (upgrade/restart Agent OS backend if this persists)`;
  }
  if (details.length) {
    const hint = details
      .slice(0, 2)
      .map((d) => d?.msg || JSON.stringify(d))
      .join('; ');
    return `${msg}${hint ? ` (${hint})` : ''}`;
  }
  return msg || rawText.slice(0, 500) || 'A2A request failed';
}

async function tryMethods(endpointUrl, methods, params, opts) {
  let lastErr;
  for (const method of methods) {
    try {
      return await jsonRpcCall(endpointUrl, method, params, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('A2A call failed');
}

/**
 * Send a user message to an external A2A agent.
 */
export async function a2aSendMessage(
  endpointUrl,
  messageText,
  {
    headers = {},
    timeoutMs = 90000,
    skillId = null,
    contextId = null,
    configuration = {},
  } = {}
) {
  const text = String(messageText || '').trim();
  if (!text) throw new Error('Message text is required for A2A invoke');

  const message = {
    role: 'user',
    messageId: randomUUID(),
    parts: [{ kind: 'text', text }],
  };
  if (contextId) message.contextId = contextId;

  const params = {
    message,
    configuration: {
      acceptedOutputModes: ['text/plain', 'text'],
      ...configuration,
    },
  };
  if (skillId) params.metadata = { ...(params.metadata || {}), skillId };

  const response = await tryMethods(endpointUrl, A2A_METHODS.send, params, { headers, timeoutMs });
  return {
    response,
    taskId: extractA2ATaskId(response),
    taskState: extractA2ATaskState(response),
    text: extractA2AResponseText(response),
  };
}

export async function a2aGetTask(endpointUrl, taskId, { headers = {}, timeoutMs = 30000 } = {}) {
  const params = { id: taskId, taskId };
  return tryMethods(endpointUrl, A2A_METHODS.getTask, params, { headers, timeoutMs });
}

export async function a2aSendAndWait(
  endpointUrl,
  messageText,
  {
    headers = {},
    timeoutMs = 120000,
    pollIntervalMs = 1500,
    skillId = null,
    contextId = null,
  } = {}
) {
  const started = Date.now();
  let sendResult = await a2aSendMessage(endpointUrl, messageText, {
    headers,
    timeoutMs: Math.min(timeoutMs, 90000),
    skillId,
    contextId,
  });

  let taskId = sendResult.taskId;
  let taskState = sendResult.taskState;
  let text = sendResult.text;
  let lastResponse = sendResult.response;

  if (!taskId || isTerminalTaskState(taskState)) {
    const syncOk = !!text && (!taskState || !String(taskState).includes('fail'));
    return {
      ok: syncOk || (!taskState && !!text),
      taskId,
      taskState: taskState || (text ? 'completed' : null),
      text,
      result: lastResponse,
    };
  }

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    lastResponse = await a2aGetTask(endpointUrl, taskId, { headers, timeoutMs: 30000 });
    taskState = extractA2ATaskState(lastResponse);
    text = extractA2AResponseText(lastResponse) || text;
    if (isTerminalTaskState(taskState)) break;
  }

  const failed = taskState && String(taskState).includes('fail');
  return {
    ok: !failed && isTerminalTaskState(taskState),
    taskId,
    taskState: taskState || 'timeout',
    text,
    result: lastResponse,
  };
}

export function resolveA2AEndpoint(card, explicitEndpoint) {
  return pickEndpoint(card, explicitEndpoint);
}
