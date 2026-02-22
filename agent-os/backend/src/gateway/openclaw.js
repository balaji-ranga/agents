/**
 * OpenClaw Gateway client - uses interface specs from docs.openclaw.ai/gateway
 * - POST /v1/chat/completions (OpenAI-compatible)
 * - Auth: Bearer token
 * - Agent: x-openclaw-agent-id (e.g. main)
 * - Session: "user" field for stable session key
 */

const DEFAULT_PORT = 18789;

function getGatewayUrl() {
  const base = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
  return base.replace(/\/$/, '');
}

function getGatewayToken() {
  return process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_PASSWORD || '';
}

/**
 * Send a chat message to OpenClaw gateway and return assistant reply.
 * @param {string} agentId - OpenClaw agent id (e.g. 'main')
 * @param {Array<{role: 'user'|'assistant'|'system', content: string}>} messages
 * @param {string} [sessionUser] - Optional stable user id for session affinity
 * @param {boolean} [stream] - If true, return async iterable of SSE chunks
 */
export async function chatCompletions(agentId, messages, sessionUser = null, stream = false) {
  const url = `${getGatewayUrl()}/v1/chat/completions`;
  const token = getGatewayToken();

  const body = {
    model: 'openclaw',
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: !!stream,
  };
  if (sessionUser) body.user = sessionUser;

  const headers = {
    'Content-Type': 'application/json',
    'x-openclaw-agent-id': agentId || 'main',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errJson;
    try { errJson = JSON.parse(errText); } catch (_) {}
    const msg = errJson?.error?.message || errText || res.statusText;
    throw new Error(`OpenClaw gateway error ${res.status}: ${msg}`);
  }

  if (stream) {
    return res.body;
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  const usage = data.usage || null;
  return { content, usage, raw: data };
}

/**
 * Derive a stable session user string for per-agent, per-user session affinity.
 */
export function sessionUserFor(agentId, userId = 'default') {
  return `agent-os:${agentId}:${userId}`;
}
