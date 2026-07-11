/**
 * API node auth — stored on workflow node taskConfig (not .env).
 */
import { renderWorkflowTemplates } from './agent-workflow-io.js';
import { renderHttpHeadersJson, mergeHttpHeaders, parseHttpHeadersJson } from './http-headers.js';

export function renderApiNodeConfig(config = {}, context = null) {
  if (!config || !context) return config || {};
  const out = { ...config };
  for (const key of [
    'bearerToken',
    'bearer_token',
    'basicUsername',
    'basic_username',
    'basicPassword',
    'basic_password',
    'apiKeyValue',
    'api_key_value',
    'apiKeyHeader',
    'api_key_header',
  ]) {
    if (out[key] != null) out[key] = renderWorkflowTemplates(String(out[key]), context);
  }
  return out;
}

export function buildApiAuthHeaders(nodeConfig = {}) {
  const authType = String(nodeConfig.authType || nodeConfig.auth_type || 'none').toLowerCase();
  const headers = {};

  if (authType === 'basic') {
    const user = String(nodeConfig.basicUsername || nodeConfig.basic_username || '');
    const pass = String(nodeConfig.basicPassword || nodeConfig.basic_password || '');
    if (user || pass) {
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
    }
  } else if (authType === 'bearer') {
    const token = String(nodeConfig.bearerToken || nodeConfig.bearer_token || '').trim();
    if (token) {
      headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
  } else if (authType === 'api_key' || authType === 'apikey') {
    const name = String(nodeConfig.apiKeyHeader || nodeConfig.api_key_header || 'X-API-Key').trim();
    const value = String(nodeConfig.apiKeyValue || nodeConfig.api_key_value || '').trim();
    if (name && value) headers[name] = value;
  }

  return headers;
}

/** Merge auth preset, node HTTP headers (Postman), and optional input-binding headers. */
export function buildApiRequestHeaders(cfg, context, resolvedInputHeadersJson) {
  const authHeaders = buildApiAuthHeaders(cfg);
  const nodeHeaders = renderHttpHeadersJson(cfg.httpHeadersJson || cfg.http_headers_json, context);
  let bindingHeaders = {};
  if (resolvedInputHeadersJson) {
    try {
      const raw = context
        ? renderWorkflowTemplates(String(resolvedInputHeadersJson), context)
        : String(resolvedInputHeadersJson);
      bindingHeaders = parseHttpHeadersJson(raw);
    } catch {
      throw new Error('headers must be valid JSON');
    }
  }
  return mergeHttpHeaders({ 'Content-Type': 'application/json' }, authHeaders, nodeHeaders, bindingHeaders);
}
