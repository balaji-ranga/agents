import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';

function isTypingTarget(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function cloneGraph(nodes, edges) {
  return {
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
  };
}

function newNodeId(type) {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Undo history + keyboard shortcuts for workflow canvas (Delete, Ctrl+X/V/Z).
 */
export function useWorkflowEditorShortcuts({
  nodes,
  edges,
  setNodes,
  setEdges,
  selectedNodeId,
  selectedEdgeId,
  setSelectedNodeId,
  setSelectedEdgeId,
  createPastedNode,
}) {
  const { screenToFlowPosition } = useReactFlow();
  const clipboardRef = useRef(null);
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const restoringRef = useRef(false);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);

  const pushHistory = useCallback(() => {
    if (restoringRef.current) return;
    const snap = cloneGraph(nodesRef.current, edgesRef.current);
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    trimmed.push(snap);
    if (trimmed.length > 50) trimmed.shift();
    historyRef.current = trimmed;
    historyIndexRef.current = trimmed.length - 1;
  }, []);

  const seedHistory = useCallback(() => {
    historyRef.current = [cloneGraph(nodesRef.current, edgesRef.current)];
    historyIndexRef.current = 0;
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return false;
    const nextIndex = historyIndexRef.current - 1;
    const snap = historyRef.current[nextIndex];
    if (!snap) return false;
    restoringRef.current = true;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    historyIndexRef.current = nextIndex;
    requestAnimationFrame(() => {
      restoringRef.current = false;
    });
    return true;
  }, [setNodes, setEdges, setSelectedNodeId, setSelectedEdgeId]);

  const deleteSelection = useCallback(() => {
    const selectedNodes = nodesRef.current.filter((n) => n.selected || n.id === selectedNodeId);
    const selectedEdges = edgesRef.current.filter((e) => e.selected || e.id === selectedEdgeId);
    if (!selectedNodes.length && !selectedEdges.length) return false;

    pushHistory();

    const nodeIds = new Set(selectedNodes.map((n) => n.id));
    const edgeIds = new Set(selectedEdges.map((e) => e.id));

    setEdges((eds) =>
      eds.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.source) && !nodeIds.has(e.target))
    );
    if (nodeIds.size) {
      setNodes((nds) => nds.filter((n) => !nodeIds.has(n.id)));
    }
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    return true;
  }, [pushHistory, selectedNodeId, selectedEdgeId, setNodes, setEdges, setSelectedNodeId, setSelectedEdgeId]);

  const copySelection = useCallback(() => {
    const node =
      nodesRef.current.find((n) => n.selected || n.id === selectedNodeId) ||
      nodesRef.current.find((n) => n.id === selectedNodeId);
    if (!node || node.type === 'trigger') return false;
    clipboardRef.current = structuredClone(node);
    return true;
  }, [selectedNodeId]);

  const pasteClipboard = useCallback(() => {
    const src = clipboardRef.current;
    if (!src) return false;

    pushHistory();

    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const id = newNodeId(src.type);
    const offset = 32 + Math.floor(Math.random() * 24);
    const pasted = createPastedNode
      ? createPastedNode(src, id, {
          x: (src.position?.x ?? center.x) + offset,
          y: (src.position?.y ?? center.y) + offset,
        })
      : {
          ...src,
          id,
          position: {
            x: (src.position?.x ?? center.x) + offset,
            y: (src.position?.y ?? center.y) + offset,
          },
          selected: true,
          data: structuredClone(src.data),
        };

    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })).concat(pasted));
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    return true;
  }, [
    pushHistory,
    screenToFlowPosition,
    createPastedNode,
    setNodes,
    setSelectedNodeId,
    setSelectedEdgeId,
  ]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (isTypingTarget(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (deleteSelection()) e.preventDefault();
        return;
      }

      if (mod && (e.key === 'x' || e.key === 'X')) {
        if (copySelection()) e.preventDefault();
        return;
      }

      if (mod && (e.key === 'v' || e.key === 'V')) {
        if (pasteClipboard()) e.preventDefault();
        return;
      }

      if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        if (undo()) e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelection, copySelection, pasteClipboard, undo]);

  return {
    pushHistory,
    seedHistory,
    undo,
    deleteSelection,
    copySelection,
    pasteClipboard,
  };
}
