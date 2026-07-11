/**
 * MCP server registry — CRUD, visibility, health, tool cache.
 */
import { randomBytes } from 'crypto';
import { getDb } from '../db/schema.js';
import { invokeMcpTool, invokeMcpPrompt, invokeMcpResource, probeMcpServer } from './mcp-client.js';
import { redactMcpAuthForLog } from './mcp-auth.js';

function sanitizeServerRow(row) {
  if (!row) return null;
  const {
    headers_json: _h,
    auth_secret_env: _a,
    env_json: _e,
    args_json,
    server_info_json,
    ...rest
  } = row;
  return {
    ...rest,
    args: parseJson(args_json, []),
    server_info: (() => {
      const info = parseJson(server_info_json, null);
      return info?.serverInfo || info;
    })(),
    is_platform: !!row.is_platform,
    can_delete: false,
    can_edit: false,
  };
}
function slugId(name) {
  const base = String(name || 'mcp')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `mcp-${base || 'server'}-${randomBytes(3).toString('hex')}`;
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function listVisibleMcpServers(authUser, { forWorkflow = false } = {}) {
  const db = getDb();
  let rows;
  if (authUser.role === 'admin') {
    rows = db.prepare('SELECT * FROM mcp_servers ORDER BY is_platform DESC, name ASC').all();
  } else {
    rows = db
      .prepare(
        `SELECT * FROM mcp_servers
         WHERE (owner_user_id = ? AND owner_role = 'ceo')
            OR (is_platform = 1 AND owner_role = 'admin')
         ORDER BY is_platform DESC, name ASC`
      )
      .all(authUser.id);
  }
  if (forWorkflow) {
    rows = rows.filter((r) => r.status === 'healthy');
  }
  return rows.map((r) => {
    const s = sanitizeServerRow(r);
    s.tool_count = db.prepare('SELECT COUNT(*) AS n FROM mcp_tools_cache WHERE server_id = ?').get(r.id)?.n || 0;
    s.prompt_count = db.prepare('SELECT COUNT(*) AS n FROM mcp_prompts_cache WHERE server_id = ?').get(r.id)?.n || 0;
    s.resource_count = db.prepare('SELECT COUNT(*) AS n FROM mcp_resources_cache WHERE server_id = ?').get(r.id)?.n || 0;
    if (forWorkflow) {
      s.tools = listCachedTools(r.id);
      s.prompts = listCachedPrompts(r.id);
      s.resources = listCachedResources(r.id);
    }
    applyPermissions(s, authUser);
    return s;
  });
}

export function getMcpServer(id, authUser) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  if (!row) return null;
  if (!canViewServer(row, authUser)) return null;
  const s = sanitizeServerRow(row);
  s.tools = listCachedTools(id);
  s.prompts = listCachedPrompts(id);
  s.resources = listCachedResources(id);
  applyPermissions(s, authUser);
  return s;
}

function canViewServer(row, authUser) {
  if (!row || !authUser) return false;
  if (authUser.role === 'admin') return true;
  if (row.is_platform && row.owner_role === 'admin') return true;
  return row.owner_user_id === authUser.id && row.owner_role === 'ceo';
}

function canEditServer(row, authUser) {
  if (!canViewServer(row, authUser)) return false;
  if (authUser.role === 'admin') return true;
  return row.owner_user_id === authUser.id && row.owner_role === 'ceo' && !row.is_platform;
}

function canDeleteServer(row, authUser) {
  if (!canViewServer(row, authUser)) return false;
  if (authUser.role === 'admin') return true;
  return row.owner_user_id === authUser.id && row.owner_role === 'ceo';
}

function applyPermissions(server, authUser) {
  const row = server;
  server.can_edit = canEditServer(row, authUser);
  server.can_delete = canDeleteServer(row, authUser);
  server.is_mine = row.owner_user_id === authUser.id;
  server.is_shared = !!row.is_platform && row.owner_role === 'admin';
}

export function createMcpServer(authUser, body = {}) {
  const name = String(body.name || '').trim();
  const url = String(body.url || '').trim();
  if (!name || !url) throw new Error('name and url are required');

  const db = getDb();
  const id = body.id?.trim() || slugId(name);
  const isPlatform = authUser.role === 'admin' ? 1 : 0;

  db.prepare(
    `INSERT INTO mcp_servers (
      id, name, description, transport, url, command, args_json, cwd, env_json, headers_json,
      auth_secret_env, owner_user_id, owner_role, is_platform, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'))`
  ).run(
    id,
    name,
    String(body.description || '').trim(),
    body.transport || 'streamable_http',
    url,
    body.command || null,
    JSON.stringify(body.args || []),
    body.cwd || null,
    '{}',
    '{}',
    '',
    authUser.id,
    authUser.role,
    isPlatform
  );

  return getMcpServer(id, authUser);
}

export function updateMcpServer(id, authUser, patch = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  if (!row) throw new Error('MCP server not found');
  if (!canEditServer(row, authUser)) throw new Error('Not allowed to edit this MCP server');

  const fields = [];
  const values = [];
  const map = {
    name: 'name',
    description: 'description',
    transport: 'transport',
    url: 'url',
    command: 'command',
    cwd: 'cwd',
    status: 'status',
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      fields.push(`${col} = ?`);
      values.push(patch[k]);
    }
  }
  if (patch.args !== undefined) {
    fields.push('args_json = ?');
    values.push(JSON.stringify(patch.args));
  }
  if (!fields.length) return getMcpServer(id, authUser);
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getMcpServer(id, authUser);
}

export function deleteMcpServer(id, authUser) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  if (!row) throw new Error('MCP server not found');
  if (!canDeleteServer(row, authUser)) throw new Error('Not allowed to delete this MCP server');
  db.prepare('DELETE FROM mcp_tools_cache WHERE server_id = ?').run(id);
  db.prepare('DELETE FROM mcp_prompts_cache WHERE server_id = ?').run(id);
  db.prepare('DELETE FROM mcp_resources_cache WHERE server_id = ?').run(id);
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  return { ok: true, id };
}

function cacheTools(serverId, tools = []) {
  const db = getDb();
  db.prepare('DELETE FROM mcp_tools_cache WHERE server_id = ?').run(serverId);
  const ins = db.prepare(
    `INSERT INTO mcp_tools_cache (server_id, tool_name, description, input_schema_json)
     VALUES (?, ?, ?, ?)`
  );
  for (const t of tools) {
    ins.run(serverId, t.name, t.description || '', JSON.stringify(t.inputSchema || t.input_schema || {}));
  }
}

function cachePrompts(serverId, prompts = []) {
  const db = getDb();
  db.prepare('DELETE FROM mcp_prompts_cache WHERE server_id = ?').run(serverId);
  const ins = db.prepare(
    `INSERT INTO mcp_prompts_cache (server_id, prompt_name, description, arguments_schema_json)
     VALUES (?, ?, ?, ?)`
  );
  for (const p of prompts) {
    ins.run(serverId, p.name, p.description || '', JSON.stringify(p.arguments || p.argumentsSchema || []));
  }
}

function cacheResources(serverId, resources = []) {
  const db = getDb();
  db.prepare('DELETE FROM mcp_resources_cache WHERE server_id = ?').run(serverId);
  const ins = db.prepare(
    `INSERT INTO mcp_resources_cache (server_id, resource_uri, name, description, mime_type)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const r of resources) {
    ins.run(
      serverId,
      r.uri,
      r.name || '',
      r.description || '',
      r.mimeType || r.mime_type || ''
    );
  }
}

export function listCachedTools(serverId) {
  const db = getDb();
  return db
    .prepare('SELECT tool_name, description, input_schema_json FROM mcp_tools_cache WHERE server_id = ? ORDER BY tool_name')
    .all(serverId)
    .map((r) => ({
      name: r.tool_name,
      description: r.description,
      input_schema: parseJson(r.input_schema_json, {}),
    }));
}

export function listCachedPrompts(serverId) {
  const db = getDb();
  return db
    .prepare('SELECT prompt_name, description, arguments_schema_json FROM mcp_prompts_cache WHERE server_id = ? ORDER BY prompt_name')
    .all(serverId)
    .map((r) => ({
      name: r.prompt_name,
      description: r.description,
      arguments_schema: parseJson(r.arguments_schema_json, []),
    }));
}

export function listCachedResources(serverId) {
  const db = getDb();
  return db
    .prepare('SELECT resource_uri, name, description, mime_type FROM mcp_resources_cache WHERE server_id = ? ORDER BY resource_uri')
    .all(serverId)
    .map((r) => ({
      uri: r.resource_uri,
      name: r.name,
      description: r.description,
      mime_type: r.mime_type,
    }));
}

export async function connectMcpServer(id, authUser, authSource = null) {
  const server = getMcpServer(id, authUser);
  if (!server) throw new Error('MCP server not found');
  const db = getDb();
  try {
    const probe = await probeMcpServer(server, authSource);
    cacheTools(id, probe.tools);
    cachePrompts(id, probe.prompts);
    cacheResources(id, probe.resources);
    db.prepare(
      `UPDATE mcp_servers SET status = 'healthy', last_health_at = datetime('now'), last_error = NULL,
       server_info_json = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify({ serverInfo: probe.server_info, instructions: probe.instructions }), id);
    return {
      ok: true,
      status: 'healthy',
      tools: probe.tools,
      prompts: probe.prompts,
      resources: probe.resources,
      server_info: probe.server_info,
      latency_ms: probe.latency_ms,
    };
  } catch (err) {
    db.prepare(
      `UPDATE mcp_servers SET status = 'draft', last_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(err.message, id);
    throw err;
  }
}

export async function callMcpServerTool(id, toolName, args, authUser, authSource = null) {
  const server = getMcpServer(id, authUser);
  if (!server) throw new Error('MCP server not found');
  if (server.status !== 'healthy') throw new Error('MCP server is not healthy — connect first');
  const started = Date.now();
  try {
    const out = await invokeMcpTool(server, toolName, args, authSource);
    logMcpCall(id, toolName, authUser?.id, { arguments: args, auth: '***' }, out, 'ok', out.latency_ms);
    return out;
  } catch (err) {
    logMcpCall(
      id,
      toolName,
      authUser?.id,
      redactMcpAuthForLog({ arguments: args, auth: authSource }),
      { error: err.message },
      'error',
      Date.now() - started
    );
    throw err;
  }
}

export async function callMcpServerPrompt(id, promptName, args, authUser, authSource = null) {
  const server = getMcpServer(id, authUser);
  if (!server) throw new Error('MCP server not found');
  if (server.status !== 'healthy') throw new Error('MCP server is not healthy — connect first');
  const started = Date.now();
  try {
    const out = await invokeMcpPrompt(server, promptName, args, authSource);
    logMcpCall(id, `prompt:${promptName}`, authUser?.id, { arguments: args, auth: '***' }, out, 'ok', out.latency_ms);
    return out;
  } catch (err) {
    logMcpCall(
      id,
      `prompt:${promptName}`,
      authUser?.id,
      redactMcpAuthForLog({ arguments: args, auth: authSource }),
      { error: err.message },
      'error',
      Date.now() - started
    );
    throw err;
  }
}

export async function callMcpServerResource(id, uri, authUser, authSource = null) {
  const server = getMcpServer(id, authUser);
  if (!server) throw new Error('MCP server not found');
  if (server.status !== 'healthy') throw new Error('MCP server is not healthy — connect first');
  const started = Date.now();
  try {
    const out = await invokeMcpResource(server, uri, authSource);
    logMcpCall(id, `resource:${uri}`, authUser?.id, { uri, auth: '***' }, out, 'ok', out.latency_ms);
    return out;
  } catch (err) {
    logMcpCall(
      id,
      `resource:${uri}`,
      authUser?.id,
      redactMcpAuthForLog({ uri, auth: authSource }),
      { error: err.message },
      'error',
      Date.now() - started
    );
    throw err;
  }
}

function logMcpCall(serverId, toolName, userId, request, response, status, latencyMs) {
  try {
    getDb()
      .prepare(
        `INSERT INTO mcp_call_logs (server_id, tool_name, user_id, request_json, response_json, status, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        serverId,
        toolName,
        userId || null,
        JSON.stringify(request || {}),
        JSON.stringify(response || {}),
        status,
        latencyMs ?? null
      );
  } catch (_) {}
}

export function listMcpCallLogs(serverId, authUser, limit = 20) {
  const server = getMcpServer(serverId, authUser);
  if (!server) throw new Error('MCP server not found');
  return getDb()
    .prepare(
      `SELECT id, tool_name, user_id, request_json, response_json, status, latency_ms, created_at
       FROM mcp_call_logs WHERE server_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(serverId, Math.min(limit, 100));
}

/** Workflow-safe list: healthy only, same visibility rules. */
export function listMcpServersForWorkflow(authUser) {
  return listVisibleMcpServers(authUser, { forWorkflow: true }).filter((s) => s.status === 'healthy');
}

export function getMcpServerForWorkflow(serverId, authUser) {
  const s = getMcpServer(serverId, authUser);
  if (!s || s.status !== 'healthy') return null;
  return s;
}
