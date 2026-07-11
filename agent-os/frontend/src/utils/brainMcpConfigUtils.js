/** Helpers for Brain node per-MCP server auth (httpHeadersJson per server id). */

export function parseMcpServerAuthMap(taskConfig = {}) {
  let raw = taskConfig.mcpServerAuth ?? taskConfig.mcp_server_auth;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [serverId, val] of Object.entries(raw)) {
    if (!serverId) continue;
    if (typeof val === 'string') out[serverId] = val;
    else if (val && typeof val === 'object') {
      out[serverId] = val.httpHeadersJson ?? val.headers ?? '{}';
    }
  }
  return out;
}

export function serverAuthHasHeaders(httpHeadersJson) {
  if (!httpHeadersJson || httpHeadersJson === '{}') return false;
  try {
    const obj = typeof httpHeadersJson === 'string' ? JSON.parse(httpHeadersJson) : httpHeadersJson;
    return Object.keys(obj || {}).some((k) => String(k).trim() && obj[k] != null && String(obj[k]).trim());
  } catch {
    return false;
  }
}

export function setServerAuthHeaders(authMap, serverId, httpHeadersJson) {
  const next = { ...authMap };
  if (!httpHeadersJson || httpHeadersJson === '{}') {
    delete next[serverId];
  } else {
    next[serverId] = httpHeadersJson;
  }
  return next;
}

export function removeServerFromAuth(authMap, serverId) {
  const next = { ...authMap };
  delete next[serverId];
  return next;
}
