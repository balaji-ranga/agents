/**
 * Parse transient or workflow-node MCP auth (no .env dependency).
 * @returns {{ headers: Record<string,string> }}
 */
export function parseMcpAuth(source = {}) {
  const auth = source.auth && typeof source.auth === 'object' ? source.auth : source;
  const bearer = String(auth.bearer || auth.bearerToken || auth.bearer_token || '').trim();
  let headers = auth.headers || {};
  if (typeof headers === 'string') {
    try {
      headers = JSON.parse(headers);
    } catch {
      headers = {};
    }
  }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) headers = {};

  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v != null && String(v).trim()) out[k] = String(v).trim();
  }
  if (bearer) {
    out.Authorization = bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}`;
  }
  return { headers: out };
}

export function parseMcpAuthFromNodeConfig(config = {}) {
  let headersRaw =
    config.httpHeadersJson ||
    config.http_headers_json ||
    config.authHeadersJson ||
    config.auth_headers_json ||
    '';
  if (config.authHeaders && typeof config.authHeaders === 'object') {
    headersRaw = JSON.stringify(config.authHeaders);
  }
  return parseMcpAuth({
    bearer: config.authBearer || config.auth_bearer || '',
    headers: headersRaw || '{}',
  });
}

export function redactMcpAuthForLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy.auth) {
    copy.auth = { bearer: copy.auth.bearer ? '***' : '', headers: '***' };
  }
  if (copy.headers?.Authorization) copy.headers.Authorization = '***';
  return copy;
}
