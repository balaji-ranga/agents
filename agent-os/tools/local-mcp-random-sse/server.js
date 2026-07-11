/**
 * Local MCP test server — random numbers + SSE event stream.
 *
 * Endpoints:
 *   POST /mcp              MCP JSON-RPC (initialize, tools/list, tools/call)
 *   GET  /events/stream    SSE — random_number events (auto every N sec + on demand)
 *   GET  /health           Health check
 *
 * Tools:
 *   get_random_number      Returns random integer 1–100
 *   emit_random_event      Broadcasts one random_number SSE event (+ optional workflow hook)
 *
 * Env:
 *   MCP_RANDOM_PORT=3099
 *   MCP_AUTO_EMIT_MS=0          — auto-emit interval (0 = off unless subscribers use emit tool)
 *   WORKFLOW_HOOK_URL=          — POST full event JSON when emitted
 *   WORKFLOW_HOOK_SECRET=       — X-Workflow-Hook-Secret header
 *
 * Run: node tools/local-mcp-random-sse/server.js
 */
import http from 'http';
import { randomInt } from 'crypto';

const PORT = Number(process.env.MCP_RANDOM_PORT || 3099);
const AUTO_EMIT_MS = Number(process.env.MCP_AUTO_EMIT_MS || 5000);
const WORKFLOW_HOOK_URL = String(process.env.WORKFLOW_HOOK_URL || '').trim();
const WORKFLOW_HOOK_SECRET = String(process.env.WORKFLOW_HOOK_SECRET || '').trim();

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();
let autoTimer = null;

function randomNumber() {
  return randomInt(1, 101);
}

function parity(n) {
  return n % 2 === 0 ? 'even' : 'odd';
}

function buildEvent(source = 'local-mcp') {
  const value = randomNumber();
  return {
    type: 'random_number',
    value,
    parity: parity(value),
    source,
    timestamp: new Date().toISOString(),
  };
}

async function notifyWorkflowHook(event) {
  if (!WORKFLOW_HOOK_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (WORKFLOW_HOOK_SECRET) headers['X-Workflow-Hook-Secret'] = WORKFLOW_HOOK_SECRET;
    await fetch(WORKFLOW_HOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
    });
  } catch (e) {
    console.warn('[local-mcp] workflow hook failed:', e.message);
  }
}

function broadcastSseEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
  notifyWorkflowHook(event).catch(() => {});
}

function emitRandomEvent(source = 'emit_tool') {
  const event = buildEvent(source);
  broadcastSseEvent(event);
  return event;
}

function startAutoEmit() {
  if (autoTimer || !AUTO_EMIT_MS || AUTO_EMIT_MS < 1000) return;
  autoTimer = setInterval(() => {
    if (sseClients.size > 0) emitRandomEvent('auto');
  }, AUTO_EMIT_MS);
}

function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  startAutoEmit();
  req.on('close', () => sseClients.delete(res));
}

const TOOLS = [
  {
    name: 'get_random_number',
    description: 'Return a random integer from 1 to 100 (does not emit SSE)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'emit_random_event',
    description: 'Generate a random number, broadcast SSE event, and optionally POST to WORKFLOW_HOOK_URL',
    inputSchema: { type: 'object', properties: {} },
  },
];

const PROMPTS = [
  {
    name: 'random_workflow_brief',
    description: 'Brief template describing the latest random number context for workflows',
    arguments: [{ name: 'topic', description: 'Optional topic label', required: false }],
  },
];

const RESOURCES = [
  {
    uri: 'random://stats/summary',
    name: 'Random stats summary',
    description: 'Static reference doc for random number MCP tests',
    mimeType: 'text/plain',
  },
];

const RESOURCE_BODIES = {
  'random://stats/summary':
    'Local MCP random server: tools get_random_number and emit_random_event; prompts random_workflow_brief; SSE at /events/stream.',
};

function jsonRpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcErr(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleMcp(body) {
  const { id, method, params } = body || {};
  if (method === 'initialize') {
    return jsonRpcOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, prompts: {}, resources: {} },
      serverInfo: { name: 'local-mcp-random-sse', version: '1.0.0' },
      instructions: 'Test MCP server with tools, prompts, resources, and SSE events.',
    });
  }
  if (method === 'notifications/initialized') {
    return null;
  }
  if (method === 'tools/list') {
    return jsonRpcOk(id, { tools: TOOLS });
  }
  if (method === 'prompts/list') {
    return jsonRpcOk(id, { prompts: PROMPTS });
  }
  if (method === 'prompts/get') {
    const name = params?.name;
    const topic = params?.arguments?.topic || 'workflow test';
    if (name === 'random_workflow_brief') {
      return jsonRpcOk(id, {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `MCP prompt brief for topic "${topic}": use get_random_number for a sample value; resources at random://stats/summary.`,
            },
          },
        ],
      });
    }
    return jsonRpcErr(id, -32601, `Unknown prompt: ${name}`);
  }
  if (method === 'resources/list') {
    return jsonRpcOk(id, { resources: RESOURCES });
  }
  if (method === 'resources/read') {
    const uri = params?.uri;
    const text = RESOURCE_BODIES[uri];
    if (!text) return jsonRpcErr(id, -32602, `Resource not found: ${uri}`);
    return jsonRpcOk(id, {
      contents: [{ uri, mimeType: 'text/plain', text }],
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'get_random_number') {
      const value = randomNumber();
      const event = { value, parity: parity(value) };
      return jsonRpcOk(id, {
        content: [{ type: 'text', text: JSON.stringify(event, null, 2) }],
      });
    }
    if (name === 'emit_random_event') {
      const event = emitRandomEvent('tools/call');
      return jsonRpcOk(id, {
        content: [{ type: 'text', text: JSON.stringify({ emitted: event, subscribers: sseClients.size }, null, 2) }],
      });
    }
    return jsonRpcErr(id, -32601, `Unknown tool: ${name}`);
  }
  return jsonRpcErr(id, -32601, `Unknown method: ${method}`);
}

function sendSseJsonRpc(res, data) {
  const lines = `event: message\ndata: ${JSON.stringify(data)}\n\n`;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(lines);
}

async function mcpHandler(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const accept = String(req.headers.accept || '');
  const wantsSse = accept.includes('text/event-stream');
  const out = handleMcp(body);

  if (out === null) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (wantsSse) {
    sendSseJsonRpc(res, out);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, subscribers: sseClients.size, port: PORT }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events/stream') {
    sseHandler(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mcp') {
    await mcpHandler(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', paths: ['POST /mcp', 'GET /events/stream', 'GET /health'] }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[local-mcp-random-sse] http://127.0.0.1:${PORT}`);
  console.log(`  POST /mcp`);
  console.log(`  GET  /events/stream`);
  if (WORKFLOW_HOOK_URL) console.log(`  Hook → ${WORKFLOW_HOOK_URL}`);
  if (AUTO_EMIT_MS >= 1000) console.log(`  Auto-emit every ${AUTO_EMIT_MS}ms when subscribers connected`);
});
