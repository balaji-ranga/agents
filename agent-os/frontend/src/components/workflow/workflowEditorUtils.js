/** Shared helpers for workflow editor step references and I/O wiring. */
import { PALETTE_ITEMS } from './WorkflowNodes.jsx';

const NODE_HANDLES_HINT = {
  if: 'Branches: true / false handles',
  while: 'Branches: loop / exit handles',
  mcp_listen: 'Long-running SSE — connect downstream IF / Parallel / Sub-workflow to handle each event',
  sse_listen: 'Long-running SSE — connect downstream IF / Parallel / Sub-workflow to handle each event',
  sub_workflow: 'Invoke another workflow by ID using manual, event, or chat trigger',
  externalAgent: 'Invoke a registered external agent via A2A protocol (JSON-RPC)',
  custom_script: 'Run an approved custom LangGraph / Python / JS script in a sandbox',
  parallel: 'Runs all outgoing branches concurrently',
  merge: 'Waits for all incoming branches before continuing',
};

export function getNodeTypeMeta(type, taskCatalog = []) {
  const catalogEntry = taskCatalog.find((t) => t.type === type);
  const paletteEntry = PALETTE_ITEMS.find((p) => p.type === type);
  return {
    type,
    label: catalogEntry?.label || paletteEntry?.label || type,
    description: paletteEntry?.desc || '',
    color: paletteEntry?.color || catalogEntry?.color || '#6366f1',
    handlesHint: NODE_HANDLES_HINT[type] || null,
  };
}

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
