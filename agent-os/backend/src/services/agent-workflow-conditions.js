/**
 * Evaluate IF / While conditions against previous step outputs.
 */

function getOutputValue(context, nodeId, outputKey = 'text') {
  const raw = context.node_outputs?.[nodeId];
  if (raw == null) return '';
  if (typeof raw === 'string') {
    if (outputKey === 'text' || outputKey === 'result' || outputKey === 'body') return raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && outputKey in parsed) return String(parsed[outputKey] ?? '');
      return raw;
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object') {
    if (outputKey in raw) return raw[outputKey] != null ? String(raw[outputKey]) : '';
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
      return l === r;
    case 'ne':
      return l !== r;
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
