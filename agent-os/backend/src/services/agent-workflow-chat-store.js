/**
 * Persistent chat history for the Workflow Builder agent (per CEO + workflow thread).
 */
import { getDb } from '../db/schema.js';

function db() {
  return getDb();
}

export function workflowChatThreadKey(workflowId) {
  return workflowId ? String(workflowId) : '';
}

export function listWorkflowChatTurns(ownerUserId, workflowId = null, limit = 100) {
  const thread = workflowChatThreadKey(workflowId);
  const rows = db()
    .prepare(
      `SELECT id, role, content, created_at FROM agent_workflow_chat_turns
       WHERE owner_user_id = ? AND workflow_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(ownerUserId, thread, Math.min(Math.max(limit, 1), 200));
  return rows;
}

export function appendWorkflowChatTurn(ownerUserId, workflowId, role, content) {
  const thread = workflowChatThreadKey(workflowId);
  const text = String(content || '').trim();
  if (!text) return null;
  const result = db()
    .prepare(
      `INSERT INTO agent_workflow_chat_turns (owner_user_id, workflow_id, role, content)
       VALUES (?, ?, ?, ?)`
    )
    .run(ownerUserId, thread, role, text);
  return {
    id: result.lastInsertRowid,
    role,
    content: text,
    created_at: new Date().toISOString(),
  };
}

export function appendWorkflowChatExchange(ownerUserId, workflowId, userMessage, assistantMessage) {
  appendWorkflowChatTurn(ownerUserId, workflowId, 'user', userMessage);
  return appendWorkflowChatTurn(ownerUserId, workflowId, 'assistant', assistantMessage);
}

export function clearWorkflowChatTurns(ownerUserId, workflowId = null) {
  const thread = workflowChatThreadKey(workflowId);
  const result = db()
    .prepare(`DELETE FROM agent_workflow_chat_turns WHERE owner_user_id = ? AND workflow_id = ?`)
    .run(ownerUserId, thread);
  return { deleted: result.changes };
}
