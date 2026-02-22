/**
 * Delegation: schedule OpenClaw Gateway cron jobs (detailed prompt, agentId, webhook) per agent.
 * Uses OpenAI to classify intent from the COO's AGENTS.md (agents and use cases); no hardcoded agent list.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';
import { cronAddOneShotWebhook } from '../gateway/openclaw-cron.js';
import { classifyIntentAndAllocate } from './intent-classifier.js';

const SESSION_USER = 'agent-os-delegation';
const AGENTS_MD_NAME = 'AGENTS.md';

function db() {
  return getDb();
}

function getBaseUrl() {
  const port = Number(process.env.PORT) || 3001;
  return (process.env.AGENT_OS_BASE_URL || process.env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
}

function getAgentsUnderCoo() {
  const coo = db().prepare('SELECT id FROM agents WHERE is_coo = 1 LIMIT 1').get();
  if (!coo) return [];
  return db()
    .prepare('SELECT id, name, role, openclaw_agent_id FROM agents WHERE parent_id = ? AND id != ?')
    .all(coo.id, coo.id);
}

/**
 * Read the COO workspace AGENTS.md (lists agents and use cases). Used by the intent classifier.
 * @returns {Promise<string>} File content or empty string if missing/unreadable
 */
async function readCooAgentsMd() {
  const coo = db().prepare('SELECT workspace_path FROM agents WHERE is_coo = 1 LIMIT 1').get();
  if (!coo?.workspace_path) return '';
  const path = join(coo.workspace_path, AGENTS_MD_NAME);
  try {
    return await readFile(path, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * Build a detailed prompt for an agent from the CEO's request (use filtered context per agent).
 */
function buildDetailedPromptForAgent(relevantMessage, agentName, agentRole) {
  const rolePart = agentRole ? ` You are ${agentName} (${agentRole}).` : ` You are ${agentName}.`;
  return `The CEO has requested the following for this standup (relevant part for you):

---
${relevantMessage.trim()}
---

${rolePart} Please provide a detailed response addressing this request only. Reply with concrete content for the CEO to review.`;
}

/**
 * Schedule CEO request via OpenClaw Gateway cron. Reads COO AGENTS.md, uses OpenAI to classify
 * intent and allocate a task query per agent (no hardcoded list). Creates one task per agent
 * that the classifier assigned a non-empty query; fallback: if classifier fails, all agents get full message.
 * @returns {{ requestId: string, count: number, scheduledCount: number, pendingCount: number, agentNames: string[] }}
 */
export async function scheduleCeoRequestViaOpenClawCron(standupId, ceoMessage) {
  const agents = getAgentsUnderCoo();
  const agentsMdContent = await readCooAgentsMd();
  const allocated = agentsMdContent
    ? await classifyIntentAndAllocate(ceoMessage, agentsMdContent)
    : null;

  const requestId = `req-${standupId}-${Date.now()}`;
  const baseUrl = getBaseUrl();
  const ins = db().prepare(
    `INSERT INTO agent_delegation_tasks (standup_id, request_id, to_agent_id, prompt, status) VALUES (?, ?, ?, ?, 'pending')`
  );
  const taskRows = [];

  if (allocated && typeof allocated === 'object' && Object.keys(allocated).length > 0) {
    for (const a of agents) {
      const query = allocated[a.id?.toLowerCase()] || allocated[a.id];
      if (!query || typeof query !== 'string') continue;
      const prompt = buildDetailedPromptForAgent(query, a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      const row = db().prepare('SELECT id FROM agent_delegation_tasks ORDER BY id DESC LIMIT 1').get();
      if (row) taskRows.push({ taskId: row.id, agent: a });
    }
  } else if (allocated === null && agents.length > 0) {
    for (const a of agents) {
      const prompt = buildDetailedPromptForAgent(ceoMessage.trim(), a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      const row = db().prepare('SELECT id FROM agent_delegation_tasks ORDER BY id DESC LIMIT 1').get();
      if (row) taskRows.push({ taskId: row.id, agent: a });
    }
  }

  const agentNames = taskRows.map((r) => r.agent.name || r.agent.id);

  let scheduledCount = 0;
  for (const { taskId, agent } of taskRows) {
    const task = db().prepare('SELECT * FROM agent_delegation_tasks WHERE id = ?').get(taskId);
    if (!task) continue;
    const webhookUrl = `${baseUrl}/api/standups/cron-callback?standup_id=${standupId}&request_id=${encodeURIComponent(requestId)}&agent_id=${encodeURIComponent(agent.id)}&task_id=${taskId}`;
    const result = await cronAddOneShotWebhook({
      name: `standup-${standupId}-${agent.id}-${taskId}`,
      agentId: agent.openclaw_agent_id || agent.id || 'main',
      message: task.prompt,
      webhookUrl,
    });
    if (result.ok) {
      scheduledCount++;
    }
    // If cron_add failed, task stays pending; processPendingDelegationTasks will run it via chat (fallback).
  }
  const pendingCount = taskRows.length - scheduledCount;
  return { requestId, count: taskRows.length, scheduledCount, pendingCount, agentNames };
}

/**
 * Enqueue delegation tasks only (no Gateway cron). Uses COO AGENTS.md + OpenAI to allocate per agent.
 */
export async function enqueueGetWorkFromTeam(standupId, contextFromConversation = '') {
  const agents = getAgentsUnderCoo();
  const requestId = `req-${standupId}-${Date.now()}`;
  const ins = db().prepare(
    `INSERT INTO agent_delegation_tasks (standup_id, request_id, to_agent_id, prompt, status) VALUES (?, ?, ?, ?, 'pending')`
  );
  const fullContext = contextFromConversation.trim() || 'Provide your status and deliverables for the CEO standup.';
  const agentsMdContent = await readCooAgentsMd();
  const allocated = agentsMdContent && fullContext ? await classifyIntentAndAllocate(fullContext, agentsMdContent) : null;

  let count = 0;
  if (allocated && typeof allocated === 'object' && Object.keys(allocated).length > 0) {
    for (const a of agents) {
      const query = allocated[a.id?.toLowerCase()] || allocated[a.id];
      if (!query || typeof query !== 'string') continue;
      const prompt = buildDetailedPromptForAgent(query, a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      count++;
    }
  } else {
    for (const a of agents) {
      const prompt = buildDetailedPromptForAgent(fullContext, a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      count++;
    }
  }
  return { requestId, count };
}

/**
 * Enqueue a single task (e.g. deep research to one agent). Returns request_id.
 */
export function enqueueDelegationTask(standupId, toAgentId, prompt, requestId = null) {
  const rid = requestId || `req-${standupId}-${Date.now()}`;
  db().prepare(
    `INSERT INTO agent_delegation_tasks (standup_id, request_id, to_agent_id, prompt, status) VALUES (?, ?, ?, ?, 'pending')`
  ).run(standupId, rid, toAgentId, prompt);
  return rid;
}

/**
 * Post COO callback message for a request_id when all its tasks are done (completed or failed).
 * Idempotent: skips if callback already posted.
 */
export function postCallbackForRequestId(requestId) {
  const alreadyPosted = db().prepare('SELECT 1 FROM delegation_callbacks WHERE request_id = ?').get(requestId);
  if (alreadyPosted) return;

  const tasks = db().prepare('SELECT * FROM agent_delegation_tasks WHERE request_id = ?').all(requestId);
  const anyPending = tasks.some((t) => t.status === 'pending');
  if (anyPending) return;

  const standupId = tasks[0]?.standup_id;
  if (!standupId) return;

  const completed = db().prepare('SELECT t.*, a.name as agent_name FROM agent_delegation_tasks t JOIN agents a ON a.id = t.to_agent_id WHERE t.request_id = ? AND t.status = ?').all(requestId, 'completed');
  const failed = db().prepare('SELECT t.*, a.name as agent_name FROM agent_delegation_tasks t JOIN agents a ON a.id = t.to_agent_id WHERE t.request_id = ? AND t.status = ?').all(requestId, 'failed');

  for (const t of completed) {
    db().prepare('INSERT INTO standup_responses (standup_id, agent_id, content) VALUES (?, ?, ?)').run(standupId, t.to_agent_id, t.response_content || '');
  }

  const lines = completed.map((t) => `**${t.agent_name}:**\n${(t.response_content || '').trim().slice(0, 2000)}`);
  if (failed.length) lines.push(...failed.map((t) => `**${t.agent_name}:** [Error: ${t.error_message}]`));
  const callbackMessage = lines.length
    ? `Updates from the team (for your review):\n\n${lines.join('\n\n---\n\n')}`
    : 'No responses from the team yet.';

  db().prepare('INSERT INTO standup_messages (standup_id, role, content) VALUES (?, ?, ?)').run(standupId, 'coo', callbackMessage);
  db().prepare('INSERT INTO delegation_callbacks (request_id) VALUES (?)').run(requestId);
}

/**
 * Process pending tasks: send to OpenClaw chat per agent, store response, then post COO callback for completed request_ids.
 * Call from "Check for updates" or node-cron (e.g. every minute).
 */
export async function processPendingDelegationTasks() {
  const pending = db().prepare('SELECT * FROM agent_delegation_tasks WHERE status = ? ORDER BY created_at LIMIT 20').all('pending');
  const now = new Date().toISOString();

  for (const task of pending) {
    const agent = db().prepare('SELECT id, name, openclaw_agent_id FROM agents WHERE id = ?').get(task.to_agent_id);
    if (!agent) {
      db().prepare('UPDATE agent_delegation_tasks SET status = ?, error_message = ?, completed_at = ? WHERE id = ?').run('failed', 'Agent not found', now, task.id);
      continue;
    }
    const openclawId = agent.openclaw_agent_id || 'main';
    try {
      const { content } = await openclaw.chatCompletions(
        openclawId,
        [{ role: 'user', content: task.prompt }],
        openclaw.sessionUserFor(openclawId, SESSION_USER),
        false
      );
      db().prepare('UPDATE agent_delegation_tasks SET status = ?, response_content = ?, completed_at = ? WHERE id = ?').run('completed', content || '(no response)', now, task.id);
    } catch (err) {
      db().prepare('UPDATE agent_delegation_tasks SET status = ?, error_message = ?, completed_at = ? WHERE id = ?').run('failed', err.message, now, task.id);
    }
  }

  const allRequestIds = db().prepare('SELECT DISTINCT request_id FROM agent_delegation_tasks').all().map((r) => r.request_id);
  for (const requestId of allRequestIds) {
    postCallbackForRequestId(requestId);
  }
}
