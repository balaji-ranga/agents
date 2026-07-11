/**
 * Brain node — MCP tool registry and invocation for LLM tool-calling loops.
 */
import { extractToolText } from './mcp-client.js';
import { parseMcpAuthFromNodeConfig } from './mcp-auth.js';
import { callMcpServerTool, getMcpServerForWorkflow } from './mcp-servers.js';

const MAX_TOOL_RESULT_CHARS = 12000;

function parseJsonArray(raw, fallback = []) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseMcpServerAuthMap(cfg = {}) {
  let raw = cfg.mcpServerAuth ?? cfg.mcp_server_auth;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  const map = new Map();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [serverId, val] of Object.entries(raw)) {
      if (!serverId) continue;
      const headersJson =
        typeof val === 'string' ? val : val?.httpHeadersJson ?? val?.http_headers_json ?? '{}';
      map.set(serverId, parseMcpAuthFromNodeConfig({ httpHeadersJson: headersJson }));
    }
  }
  const legacyAuth = parseMcpAuthFromNodeConfig(cfg);
  return { map, legacyAuth };
}

export function resolveServerMcpAuth(serverId, serverAuthMap, legacyAuth) {
  if (serverAuthMap?.has?.(serverId)) return serverAuthMap.get(serverId);
  return legacyAuth;
}

export function parseBrainMcpConfig(cfg = {}) {
  const serverIds = parseJsonArray(cfg.mcpServerIds ?? cfg.mcp_server_ids, []).filter(Boolean);
  const allowlistRaw = parseJsonArray(cfg.mcpToolAllowlist ?? cfg.mcp_tool_allowlist, []).filter(Boolean);
  const enabled =
    cfg.mcpToolCalling === true ||
    cfg.mcpToolCalling === 1 ||
    cfg.mcp_tool_calling === true ||
    String(cfg.mcpToolMode || '').toLowerCase() === 'auto';

  const { map: serverAuthMap, legacyAuth } = parseMcpServerAuthMap(cfg);

  return {
    enabled,
    serverIds,
    allowlist: new Set(allowlistRaw),
    maxRounds: Math.min(Math.max(Number(cfg.mcpMaxToolRounds ?? cfg.mcp_max_tool_rounds) || 8, 1), 20),
    serverAuthMap,
    legacyAuth,
  };
}

function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const copy = structuredClone(schema);
  if (!copy.type) copy.type = 'object';
  if (copy.type === 'object' && !copy.properties) copy.properties = {};
  return copy;
}

/** Per-server: empty allowlist entries for a server → all its tools; otherwise only listed tools. */
function isToolAllowed(serverId, toolName, allowlist) {
  if (!allowlist.size) return true;
  const prefix = `${serverId}::`;
  const serverRestricted = [...allowlist].some((k) => k.startsWith(prefix));
  if (!serverRestricted) return true;
  return allowlist.has(`${serverId}::${toolName}`);
}

/** Build flat tool list with stable refs (mcp_t0, mcp_t1, …) for LLM function names. */
export function buildMcpToolRegistry(serverIds, allowlist, authUser) {
  const entries = [];
  let index = 0;
  for (const serverId of serverIds) {
    const server = getMcpServerForWorkflow(serverId, authUser);
    if (!server) continue;
    for (const tool of server.tools || []) {
      if (!isToolAllowed(serverId, tool.name, allowlist)) continue;
      entries.push({
        ref: `mcp_t${index++}`,
        serverId,
        serverName: server.name || serverId,
        toolName: tool.name,
        description: tool.description || tool.name,
        inputSchema: sanitizeJsonSchema(tool.input_schema),
      });
    }
  }
  return entries;
}

export function entriesToOpenAiTools(entries) {
  return entries.map((e) => ({
    type: 'function',
    function: {
      name: e.ref,
      description: `[${e.serverName}] ${e.toolName}: ${e.description}`.slice(0, 1024),
      parameters: e.inputSchema,
    },
  }));
}

export function entriesToAnthropicTools(entries) {
  return entries.map((e) => ({
    name: e.ref,
    description: `[${e.serverName}] ${e.toolName}: ${e.description}`.slice(0, 1024),
    input_schema: e.inputSchema,
  }));
}

export function findEntryByRef(entries, ref) {
  return entries.find((e) => e.ref === ref) || null;
}

function truncateToolResult(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]`;
}

export async function invokeRegistryTool(entry, args, authUser, nodeAuth) {
  const out = await callMcpServerTool(entry.serverId, entry.toolName, args || {}, authUser, nodeAuth);
  const text = out.text || extractToolText(out.result) || JSON.stringify(out.result ?? {});
  return {
    ok: !out.is_error,
    text: truncateToolResult(text),
    raw: out,
  };
}

export async function dispatchToolCall(ref, args, entries, authUser, serverAuthMap, legacyAuth) {
  const entry = findEntryByRef(entries, ref);
  if (!entry) {
    return {
      log: { ref, ok: false, error: `Unknown tool: ${ref}` },
      content: JSON.stringify({ error: `Unknown tool: ${ref}` }),
    };
  }
  const nodeAuth = resolveServerMcpAuth(entry.serverId, serverAuthMap, legacyAuth);
  try {
    const inv = await invokeRegistryTool(entry, args, authUser, nodeAuth);
    return {
      log: {
        ref,
        serverId: entry.serverId,
        serverName: entry.serverName,
        toolName: entry.toolName,
        ok: inv.ok,
      },
      content: inv.text || JSON.stringify({ ok: inv.ok }),
    };
  } catch (err) {
    return {
      log: {
        ref,
        serverId: entry.serverId,
        serverName: entry.serverName,
        toolName: entry.toolName,
        ok: false,
        error: err.message,
      },
      content: JSON.stringify({ error: err.message }),
    };
  }
}
