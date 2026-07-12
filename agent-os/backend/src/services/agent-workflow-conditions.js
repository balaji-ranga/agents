/**
 * Evaluate IF / While conditions against previous step outputs.
 */

function getNestedValue(raw, path) {
  if (raw == null || !path) return '';
  const parts = String(path).split('.');
  let cur = raw;
  for (const p of parts) {
    if (cur == null) return '';
    if (typeof cur === 'string') {
      try {
        cur = JSON.parse(cur);
      } catch {
        return '';
      }
    }
    cur = cur[p];
  }
  if (cur == null) return '';
  if (typeof cur === 'object') return JSON.stringify(cur);
  return String(cur);
}

function getOutputValue(context, nodeId, outputKey = 'text') {
  const raw = context.node_outputs?.[nodeId];
  if (raw == null) return '';
  if (typeof raw === 'string') {
    if (outputKey === 'text' || outputKey === 'result' || outputKey === 'body') return raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (outputKey.includes('.')) return getNestedValue(parsed, outputKey);
        if (outputKey in parsed) return String(parsed[outputKey] ?? '');
      }
      return raw;
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object') {
    if (outputKey.includes('.')) return getNestedValue(raw, outputKey);
    if (outputKey in raw) {
      const v = raw[outputKey];
      if (v != null && typeof v === 'object') return JSON.stringify(v);
      return v != null ? String(v) : '';
    }
    if (raw.text != null) return String(raw.text);
    return JSON.stringify(raw);
  }
  return String(raw);
}

export function resolveConditionValue(condition, context) {
  if (!condition) return '';
  if (condition.mode === 'static') return String(condition.value ?? '');
  if (condition.sourceNodeId) {
    return getOutputValue(context, condition.sourceNodeId, condition.sourceOutputKey || 'text');
  }
  return String(condition.value ?? '');
}

export function evaluateCondition(condition, context) {
  if (!condition?.sourceNodeId && condition?.mode !== 'static') return false;

  const left = resolveConditionValue(
    {
      mode: 'dynamic',
      sourceNodeId: condition.sourceNodeId,
      sourceOutputKey: condition.sourceOutputKey || 'text',
    },
    context
  );
  const right = String(condition.compareValue ?? condition.value ?? '');
  const op = condition.operator || 'contains';

  const l = left.trim();
  const r = right.trim();

  switch (op) {
    case 'eq':
      return l === r || l.toLowerCase() === r.toLowerCase();
    case 'ne':
      return l !== r && l.toLowerCase() !== r.toLowerCase();
    case 'contains':
      return l.toLowerCase().includes(r.toLowerCase());
    case 'not_contains':
      return !l.toLowerCase().includes(r.toLowerCase());
    case 'gt':
      return Number(l) > Number(r);
    case 'lt':
      return Number(l) < Number(r);
    case 'gte':
      return Number(l) >= Number(r);
    case 'lte':
      return Number(l) <= Number(r);
    case 'empty':
      return !l;
    case 'not_empty':
      return !!l;
    case 'approved':
      return l.toLowerCase() === 'approved' || l.toLowerCase() === 'true';
    case 'rejected':
      return l.toLowerCase() === 'rejected' || l.toLowerCase() === 'false';
    default:
      return l.toLowerCase().includes(r.toLowerCase());
  }
}
