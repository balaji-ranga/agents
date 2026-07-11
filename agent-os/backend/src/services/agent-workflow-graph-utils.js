/**
 * Workflow graph traversal helpers.
 */
export function getOutgoingEdges(graph, fromNodeId) {
  return (graph?.edges || []).filter((e) => e.source === fromNodeId);
}

export function getIncomingEdges(graph, toNodeId) {
  return (graph?.edges || []).filter((e) => e.target === toNodeId);
}

/** All nodes reachable from outgoing edges of fromNodeId (excludes fromNodeId). */
export function getDownstreamNodeIds(graph, fromNodeId) {
  const visited = new Set();
  const queue = getOutgoingEdges(graph, fromNodeId).map((e) => e.target);
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of getOutgoingEdges(graph, id)) queue.push(e.target);
  }
  return visited;
}

export function getNodeFromGraph(graph, nodeId) {
  return (graph?.nodes || []).find((n) => n.id === nodeId) || null;
}
