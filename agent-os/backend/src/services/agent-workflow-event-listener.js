/**
 * In-process registry for persistent SSE listen subscriptions.
 */
import { getDb } from '../db/schema.js';
import { subscribeSseStream } from './sse-stream.js';

/** @type {Map<string, { abort: () => void }>} */
const active = new Map();

function key(runId, nodeId) {
  return `${runId}:${nodeId}`;
}

export function registerPendingListener({ runId, nodeId, streamUrl, mcpServerId, eventsPath }) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO agent_workflow_pending_listeners
       (run_id, node_id, mcp_server_id, events_path, timeout_ms, started_at)
       VALUES (?, ?, ?, ?, 0, datetime('now'))`
    )
    .run(runId, nodeId, mcpServerId || null, eventsPath || streamUrl || '/events/stream');
}

export function clearPendingListener(runId, nodeId) {
  active.get(key(runId, nodeId))?.abort?.();
  active.delete(key(runId, nodeId));
  getDb().prepare('DELETE FROM agent_workflow_pending_listeners WHERE run_id = ? AND node_id = ?').run(runId, nodeId);
}

export function startPersistentListen({ runId, nodeId, streamUrl, authSource, onEvent, onEnd, onError }) {
  clearPendingListener(runId, nodeId);
  registerPendingListener({ runId, nodeId, streamUrl, eventsPath: streamUrl });

  const abort = subscribeSseStream(streamUrl, {
    authSource,
    onEvent,
    onEnd: (meta) => {
      clearPendingListener(runId, nodeId);
      onEnd?.(meta);
    },
    onError: (err) => {
      clearPendingListener(runId, nodeId);
      onError?.(err);
    },
  });

  active.set(key(runId, nodeId), { abort });
  return abort;
}

export function stopPersistentListen(runId, nodeId) {
  const entry = active.get(key(runId, nodeId));
  if (entry) entry.abort();
  clearPendingListener(runId, nodeId);
  return !!entry;
}

export function cancelAllListenersForRun(runId) {
  for (const k of [...active.keys()]) {
    if (k.startsWith(`${runId}:`)) clearPendingListener(runId, k.split(':')[1]);
  }
}

export function isListenActive(runId, nodeId) {
  return active.has(key(runId, nodeId));
}
