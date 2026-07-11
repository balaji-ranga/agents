/**
 * Shared HTTP header parsing / merge for API and MCP workflow nodes.
 */
import { renderWorkflowTemplates } from './agent-workflow-io.js';

export function parseHttpHeadersJson(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) {
      const out = {};
      for (const row of parsed) {
        const k = String(row?.key || row?.name || '').trim();
        if (k) out[k] = row?.value != null ? String(row.value) : '';
      }
      return out;
    }
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}
  return {};
}

export function renderHttpHeadersJson(raw, context = null) {
  const obj = parseHttpHeadersJson(raw);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.trim()) continue;
    out[k.trim()] = context ? renderWorkflowTemplates(String(v ?? ''), context) : String(v ?? '');
  }
  return out;
}

export function mergeHttpHeaders(...layers) {
  return Object.assign({}, ...layers.filter(Boolean));
}
