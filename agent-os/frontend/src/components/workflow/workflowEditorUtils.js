/** Shared helpers for workflow editor step references and I/O wiring. */

export function formatNodeStepLabel(node) {
  if (!node) return '';
  const label = node.data?.label || node.type;
  return `${label} · ${node.id} (${node.type})`;
}

export function getSourceOutputKeyOptions(sourceNode, taskCatalog) {
  if (!sourceNode) return [];
  const catalog = taskCatalog?.find((t) => t.type === sourceNode.type);
  const outs = sourceNode.data?.outputs?.length ? sourceNode.data.outputs : catalog?.outputs || [];
  return outs.map((o) => ({
    value: o.id,
    label: o.label ? `${o.id} — ${o.label}` : o.id,
  }));
}

export function listPriorNodes(allNodes, currentNodeId, { includeTrigger = false } = {}) {
  return allNodes.filter((n) => {
    if (n.id === currentNodeId) return false;
    if (!includeTrigger && n.type === 'trigger') return false;
    return true;
  });
}
