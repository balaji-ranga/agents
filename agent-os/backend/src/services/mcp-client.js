/**
 * MCP client — Streamable HTTP / SSE JSON-RPC (remote).
 * Auth is passed per request (test playground) or from workflow node config — never from .env.
 */
import { parseMcpAuth } from './mcp-auth.js';

function parseSseJson(text) {
  const lines = String(text || '').split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch (_) {}
    }
  }
  return events;
}

function buildHeaders(authSource = null) {
  const { headers: authHeaders } = parseMcpAuth(authSource || {});
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...authHeaders,
  };
}

async function postMcp(url, body, headers, timeoutMs = 120000) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const sessionId = res.headers.get('mcp-session-id');
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  let data;
  if (ct.includes('event-stream')) {
    const events = parseSseJson(text);
    data = events.find((e) => e.id === body.id) || events[events.length - 1];
  } else {
    data = JSON.parse(text);
  }
  if (data?.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return { data, sessionId };
}

export class McpHttpClient {
  constructor(server, authSource = null) {
    this.server = server;
    this.url = (server.url || '').trim().replace(/\/$/, '');
    this.authSource = authSource;
    this.sessionId = null;
  }

  async call(method, params = {}) {
    const id = Date.now();
    const headers = buildHeaders(this.authSource);
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const { data, sessionId } = await postMcp(
      this.url,
      { jsonrpc: '2.0', id, method, params },
      headers
    );
    if (sessionId) this.sessionId = sessionId;
    return data?.result;
  }

  async initialize() {
    const result = await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-os', version: '1.0' },
    });
    try {
      await this.call('notifications/initialized', {});
    } catch (_) {}
    return result;
  }

  async listTools() {
    const result = await this.call('tools/list', {});
    return result?.tools || [];
  }

  async listPrompts() {
    try {
      const result = await this.call('prompts/list', {});
      return result?.prompts || [];
    } catch (_) {
      return [];
    }
  }

  async getPrompt(name, args = {}) {
    const result = await this.call('prompts/get', { name, arguments: args || {} });
    return result;
  }

  async listResources() {
    try {
      const result = await this.call('resources/list', {});
      return result?.resources || [];
    } catch (_) {
      return [];
    }
  }

  async readResource(uri) {
    const result = await this.call('resources/read', { uri });
    return result;
  }

  async callTool(name, args = {}) {
    const result = await this.call('tools/call', { name, arguments: args || {} });
    return result;
  }
}

export function extractToolText(result) {
  if (!result) return '';
  const blocks = result.content || [];
  return blocks
    .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
    .join('\n')
    .trim();
}

export function extractPromptText(result) {
  if (!result) return '';
  const messages = result.messages || [];
  return messages
    .map((m) => {
      const parts = m.content;
      if (typeof parts === 'string') return `${m.role}: ${parts}`;
      if (Array.isArray(parts)) {
        return `${m.role}: ${parts.map((p) => (p.type === 'text' ? p.text : JSON.stringify(p))).join('\n')}`;
      }
      return `${m.role}: ${JSON.stringify(parts)}`;
    })
    .join('\n\n')
    .trim();
}

export function extractResourceText(result) {
  if (!result) return '';
  const contents = result.contents || (result.content ? [result.content] : []);
  return contents
    .map((c) => {
      if (c.text) return c.text;
      if (c.blob) return `[binary ${c.mimeType || 'data'}]`;
      return JSON.stringify(c);
    })
    .join('\n')
    .trim();
}

export async function probeMcpServer(server, authSource = null) {
  const transport = (server.transport || 'streamable_http').toLowerCase();
  if (transport === 'stdio') {
    throw new Error('Local stdio MCP servers are not yet supported in this build');
  }
  if (!server.url) throw new Error('MCP URL is required');
  const client = new McpHttpClient(server, authSource);
  const started = Date.now();
  const init = await client.initialize();
  const tools = await client.listTools();
  const prompts = await client.listPrompts();
  const resources = await client.listResources();
  return {
    ok: true,
    latency_ms: Date.now() - started,
    server_info: init?.serverInfo || null,
    instructions: init?.instructions || null,
    tools,
    prompts,
    resources,
  };
}

export async function invokeMcpTool(server, toolName, args = {}, authSource = null) {
  const client = new McpHttpClient(server, authSource);
  await client.initialize();
  const started = Date.now();
  const result = await client.callTool(toolName, args);
  return {
    result,
    text: extractToolText(result),
    latency_ms: Date.now() - started,
    is_error: !!result?.isError,
  };
}

export async function invokeMcpPrompt(server, promptName, args = {}, authSource = null) {
  const client = new McpHttpClient(server, authSource);
  await client.initialize();
  const started = Date.now();
  const result = await client.getPrompt(promptName, args);
  return {
    result,
    text: extractPromptText(result),
    latency_ms: Date.now() - started,
    is_error: false,
  };
}

export async function invokeMcpResource(server, uri, authSource = null) {
  const client = new McpHttpClient(server, authSource);
  await client.initialize();
  const started = Date.now();
  const result = await client.readResource(uri);
  return {
    result,
    text: extractResourceText(result),
    latency_ms: Date.now() - started,
    is_error: false,
  };
}
