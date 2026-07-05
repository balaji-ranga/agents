/**
 * OpenClaw Gateway client - uses interface specs from docs.openclaw.ai/gateway
 * - POST /v1/chat/completions (OpenAI-compatible)
 * - Auth: Bearer token
 * - Agent: x-openclaw-agent-id (e.g. main)
 * - Session: "user" field for stable session key
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_PORT = 18789;
let _cachedGatewayToken = null;

/** System instruction: get session history for context before responding (injected into chat when backend sends to gateway). */
export const CHAT_INSTRUCTION_SESSION_HISTORY =
  'Before responding: get your session history for context (e.g. use sessions_history with your session key) so you have the conversation context.';

/** Force managed Playwright browser — avoid chrome extension relay unless user asks. */
export const CHAT_INSTRUCTION_BROWSER =
  'When using the browser tool, always set profile="openclaw" (managed Playwright/Chromium). Do NOT use profile="chrome" and do NOT ask the user to click the OpenClaw Chrome extension unless they explicitly requested attaching their own Chrome tab.';

function getGatewayUrl() {
  const base = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
  return base.replace(/\/$/, '');
}

function getGatewayToken() {
  if (_cachedGatewayToken) return _cachedGatewayToken;
  const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_PASSWORD || '';
  if (fromEnv) {
    _cachedGatewayToken = fromEnv;
    return fromEnv;
  }
  const homedir = process.env.USERPROFILE || process.env.HOME || '';
  const cfgPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir, '.openclaw', 'openclaw.json');
  if (existsSync(cfgPath)) {
    try {
      const token = JSON.parse(readFileSync(cfgPath, 'utf8'))?.gateway?.auth?.token || '';
      if (token) {
        _cachedGatewayToken = token;
        return token;
      }
    } catch (_) {}
  }
  return '';
}

/**
 * Send a chat message to OpenClaw gateway and return assistant reply.
 * @param {string} agentId - OpenClaw agent id (e.g. 'main')
 * @param {Array<{role: 'user'|'assistant'|'system', content: string}>} messages
 * @param {string} [sessionUser] - Optional stable user id for session affinity
 * @param {boolean} [stream] - If true, return async iterable of SSE chunks
 */
export async function chatCompletions(agentId, messages, sessionUser = null, stream = false, options = {}) {
  const url = `${getGatewayUrl()}/v1/chat/completions`;
  const token = getGatewayToken();
  const injectSessionHistoryInstruction = options.injectSessionHistoryInstruction !== false;
  const injectBrowserInstruction = options.injectBrowserInstruction !== false;
  const systemParts = [];
  if (injectSessionHistoryInstruction) systemParts.push(CHAT_INSTRUCTION_SESSION_HISTORY);
  if (injectBrowserInstruction) systemParts.push(CHAT_INSTRUCTION_BROWSER);
  const outMessages = systemParts.length > 0
    ? [{ role: 'system', content: systemParts.join('\n\n') }, ...messages]
    : messages;

  const body = {
    model: 'openclaw',
    messages: outMessages.map((m) => ({ role: m.role, content: m.content })),
    stream: !!stream,
  };
  if (sessionUser) body.user = sessionUser;

  const headers = {
    'Content-Type': 'application/json',
    'x-openclaw-agent-id': agentId || 'main',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Pin session so gateway stores under this exact key (sessions_history will find it)
  if (sessionUser) headers['x-openclaw-session-key'] = sessionKeyFor(agentId || 'main', sessionUser);

  const timeoutMs = Number(
    options.timeoutMs || process.env.OPENCLAW_FETCH_TIMEOUT_MS || 240000
  );
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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
  // IMPORTANT: Keep the OpenClaw "user" value free of ":" (and other special chars).
  const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `agent-os-${safe(agentId)}-${safe(userId)}`;
}

/**
 * Build the session key string the gateway uses, so we can inject it into prompts.
 * Agent uses this in sessions_history to get context for this run only.
 */
export function sessionKeyFor(agentId, sessionUser) {
  return `agent::${agentId}:${sessionUser}`;
}
