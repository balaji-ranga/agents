/**
 * Delegation: schedule OpenClaw Gateway cron jobs (detailed prompt, agentId, webhook) per agent.
 * Uses OpenAI to classify intent from the COO's AGENTS.md (agents and use cases); no hardcoded agent list.
 * Injects agent MEMORY.md into prompts (OpenClaw does not inject it in isolated cron runs) and appends completions to MEMORY.md.
 */
import { readFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';
import { cronAddOneShotWebhook } from '../gateway/openclaw-cron.js';
import { classifyIntentAndAllocate } from './intent-classifier.js';
import {
  maybeHandoffJobPipeline,
  filterPipelineDelegationsForProcessing,
  failPipelineWorkflowForDelegation,
  recoverStaleProcessingDelegations,
} from './job-applicant-pipeline.js';
import { completePipelineKanbanForDelegation } from './kanban-workflow-stage.js';
import {
  completeAgentWorkflowKanbanForDelegation,
  isAgentWorkflowPrompt,
} from './agent-workflow-kanban.js';
import { maybeAdvanceAgentWorkflow, failAgentWorkflowForDelegation } from './agent-workflow-runner.js';

const SESSION_USER = 'agent-os-delegation';
const AGENTS_MD_NAME = 'AGENTS.md';
const MEMORY_MD_NAME = 'MEMORY.md';
const MEMORY_MAX_LINES = 35;
const homedir = process.env.USERPROFILE || process.env.HOME || '';

/** Prevent duplicate concurrent runs of the same delegation within this process. */
const runningDelegationIds = new Set();

function db() {
  return getDb();
}

/** Normalize OpenClaw/OpenAI reply to a single string (so standup and agent chat store same shape). */
export function normalizeReplyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((p) => {
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text' && p.text) return p.text;
      if ((p.type === 'image_url' || p.type === 'image') && (p.image_url?.url || p.image_url)) {
        const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
        return url ? `\n![image](${url})\n` : '';
      }
      return '';
    });
    return parts.join('');
  }
  return String(content);
}

/** Truncate to maxLen but don't cut in the middle of a markdown image or http URL (so frontend can still render). */
function truncatePreservingImages(text, maxLen = 2000) {
  const s = (text || '').trim();
  if (s.length <= maxLen) return s;
  let cut = s.slice(0, maxLen);
  const rest = s.slice(maxLen);
  // If we cut inside ![ or ](http, extend to include the full image
  const mdImgStart = cut.lastIndexOf('![');
  const mdImgParen = rest.indexOf(')');
  if (mdImgStart !== -1 && cut.indexOf('](', mdImgStart) === -1 && mdImgParen !== -1) {
    cut = cut + rest.slice(0, mdImgParen + 1);
  } else {
    const lastOpen = cut.lastIndexOf('](http');
    if (lastOpen !== -1) {
      const close = rest.indexOf(')');
      if (close !== -1) cut = cut + rest.slice(0, close + 1);
    }
  }
  return cut;
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
 * Get workspace path for an agent (from DB or default under ~/.openclaw).
 */
function getAgentWorkspacePath(agentId) {
  const row = db().prepare('SELECT workspace_path FROM agents WHERE id = ?').get(agentId);
  if (row?.workspace_path) return row.workspace_path;
  const dir = agentId === 'bala' ? 'workspace' : `workspace-${agentId}`;
  return join(homedir, '.openclaw', dir);
}

/**
 * Read agent's MEMORY.md (recent completions). Returns content to inject into prompt, or empty string.
 */
async function readAgentMemory(agentId) {
  const workspacePath = getAgentWorkspacePath(agentId);
  const memoryPath = join(workspacePath, MEMORY_MD_NAME);
  try {
    const raw = await readFile(memoryPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const bulletLines = lines.filter((l) => /^\s*[-*]/.test(l) || /^\d+\./.test(l));
    const recent = bulletLines.slice(-MEMORY_MAX_LINES);
    if (recent.length === 0) return '';
    return recent.join('\n').slice(0, 2500);
  } catch (_) {
    return '';
  }
}

/**
 * Extract the actual task content from a delegation prompt for use as a memory summary.
 * Prompt format: "... ---\n<task content>\n---\n..." or "New request:\n\n<base prompt>".
 * Returns a short string (max 120 chars) describing what was done, not the generic intro.
 */
export function extractTaskSummaryFromPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'Task completed';
  const trimmed = prompt.trim();
  const betweenMarkers = trimmed.match(/---\s*\n([\s\S]*?)\n\s*---/);
  if (betweenMarkers && betweenMarkers[1]) {
    const content = betweenMarkers[1].trim().replace(/\s+/g, ' ');
    return content.slice(0, 120) || 'Task completed';
  }
  if (trimmed.includes('New request:')) {
    const after = trimmed.split('New request:')[1];
    if (after) {
      const firstLine = after.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 120);
      return firstLine || 'Task completed';
    }
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 120) || 'Task completed';
}

/**
 * Append delegation task request and response to agent's chat_turns so Agent Chat page shows it.
 */
export function appendDelegationResponseToAgentChat(agentId, promptSnippet, responseContent) {
  if (!agentId || responseContent == null) return;
  const db = getDb();
  const userMsg = (promptSnippet || 'Task from COO').trim().slice(0, 4000);
  const assistantMsg = (typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent)).trim().slice(0, 100000);
  try {
    db.prepare('INSERT INTO chat_turns (agent_id, role, content) VALUES (?, ?, ?)').run(agentId, 'user', userMsg);
    db.prepare('INSERT INTO chat_turns (agent_id, role, content) VALUES (?, ?, ?)').run(agentId, 'assistant', assistantMsg);
  } catch (_) {}
}

/**
 * Append a completion line to the agent's MEMORY.md. Call when a delegation task completes.
 */
export async function appendToAgentMemory(agentId, summaryLine) {
  const workspacePath = getAgentWorkspacePath(agentId);
  const memoryPath = join(workspacePath, MEMORY_MD_NAME);
  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${summaryLine} – ${date}\n`;
  try {
    await appendFile(memoryPath, line, 'utf8');
  } catch (_) {
    // workspace or file may not exist; ignore
  }
}

/**
 * Build prompt instructing the agent to get session history for context, read MEMORY.md, and only respond if not already done today.
 * We do not inject memory content here (it was truncated); the agent reads MEMORY.md from its workspace.
 * Exported for use by standup-delegate and cron/standup so all COO-sent instructions include this.
 */
export async function getPromptWithMemoryInjected(agentId, basePrompt) {
  return `Before responding: get your session history for context (use sessions_history with your session key if available) so you have the conversation context. Then read your MEMORY.md file in your workspace. If you have already responded to this request or a very similar one today (check the entries there), reply briefly that you already did so and ask whether to redo or reuse. If not, respond to the request below.

---
${basePrompt.trim()}
---`;
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
 * Get recent standup context for intent classification: last user messages and agent responses.
 * Excludes the current message from lastUserMessages when it matches ceoMessage.
 * @param {number} standupId
 * @param {string} [ceoMessage] - Current message; if provided, the most recent user message matching it is excluded from lastUserMessages
 * @returns {{ lastUserMessages: string[], agentResponses: { agent_id: string, content: string }[] }}
 */
function getStandupContextForIntent(standupId, ceoMessage = '') {
  const currentTrim = (ceoMessage || '').trim();
  const userRows = db()
    .prepare('SELECT content FROM standup_messages WHERE standup_id = ? AND role = ? ORDER BY created_at DESC LIMIT 9')
    .all(standupId, 'user');
  const lastUserMessages = userRows.map((r) => (r.content || '').trim()).filter(Boolean);
  if (lastUserMessages.length && currentTrim && lastUserMessages[0] === currentTrim) {
    lastUserMessages.shift();
  }
  lastUserMessages.reverse();

  const taskRows = db()
    .prepare(
      'SELECT to_agent_id AS agent_id, response_content AS content, completed_at FROM agent_delegation_tasks WHERE standup_id = ? AND status = ? AND response_content IS NOT NULL AND response_content != ? ORDER BY completed_at DESC LIMIT 10'
    )
    .all(standupId, 'completed', '');
  const responseRows = db()
    .prepare('SELECT agent_id, content, submitted_at FROM standup_responses WHERE standup_id = ? ORDER BY submitted_at DESC LIMIT 10')
    .all(standupId);
  const withDate = [
    ...taskRows.map((r) => ({ agent_id: r.agent_id, content: r.content || '', at: r.completed_at })),
    ...responseRows.map((r) => ({ agent_id: r.agent_id, content: r.content || '', at: r.submitted_at })),
  ].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const agentResponses = withDate.slice(0, 10).map((r) => ({ agent_id: r.agent_id, content: r.content }));

  return { lastUserMessages, agentResponses };
}

/**
 * Schedule CEO request via OpenClaw Gateway cron. Reads COO AGENTS.md, uses OpenAI to classify
 * intent and allocate a task query per agent (no hardcoded list). Creates one task per agent
 * that the classifier assigned a non-empty query; fallback: if classifier fails, all agents get full message.
 * Passes recent user messages and agent responses as context for follow-up resolution.
 * @returns {{ requestId: string, count: number, scheduledCount: number, pendingCount: number, agentNames: string[] }}
 */
export async function scheduleCeoRequestViaOpenClawCron(standupId, ceoMessage) {
  const agents = getAgentsUnderCoo();
  const agentsMdContent = await readCooAgentsMd();
  const context = getStandupContextForIntent(standupId, ceoMessage);
  const allocated = await classifyIntentAndAllocate(ceoMessage, agentsMdContent || '', context);

  const requestId = `req-${standupId}-${Date.now()}`;
  const baseUrl = getBaseUrl();
  const ins = db().prepare(
    `INSERT INTO agent_delegation_tasks (standup_id, request_id, to_agent_id, prompt, status) VALUES (?, ?, ?, ?, 'pending')`
  );
  const taskRows = [];

  const kanbanIns = db().prepare(
    `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by, standup_id, agent_delegation_task_id) VALUES (?, ?, 'awaiting_confirmation', ?, 'coo', ?, ?)`
  );

  // Intent-based: when classifier returns at least one agent, delegate only to those with a query.
  if (allocated && typeof allocated === 'object' && Object.keys(allocated).length > 0) {
    for (const a of agents) {
      const query = allocated[a.id?.toLowerCase()] ?? allocated[a.id];
      if (!query || typeof query !== 'string') continue;
      const prompt = buildDetailedPromptForAgent(query, a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      const row = db().prepare('SELECT id FROM agent_delegation_tasks ORDER BY id DESC LIMIT 1').get();
      if (row) {
        taskRows.push({ taskId: row.id, agent: a, query });
        const title = (query || '').trim().slice(0, 200);
        kanbanIns.run(title, '', a.id, standupId, row.id);
      }
    }
  } else if (allocated === null && agents.length > 0) {
    // Classifier failed (API error, no AGENTS.md, etc.): fall back to all agents.
    for (const a of agents) {
      const prompt = buildDetailedPromptForAgent(ceoMessage.trim(), a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      const row = db().prepare('SELECT id FROM agent_delegation_tasks ORDER BY id DESC LIMIT 1').get();
      if (row) {
        taskRows.push({ taskId: row.id, agent: a, query: ceoMessage.trim() });
        const title = (ceoMessage || '').trim().slice(0, 200);
        kanbanIns.run(title, '', a.id, standupId, row.id);
      }
    }
  } else if ((!allocated || Object.keys(allocated).length === 0) && agents.length > 0) {
    // No agent mapped (empty object or no keys): fall back to all agents with full message.
    for (const a of agents) {
      const prompt = buildDetailedPromptForAgent(ceoMessage.trim(), a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      const row = db().prepare('SELECT id FROM agent_delegation_tasks ORDER BY id DESC LIMIT 1').get();
      if (row) {
        taskRows.push({ taskId: row.id, agent: a, query: ceoMessage.trim() });
        const title = (ceoMessage || '').trim().slice(0, 200);
        kanbanIns.run(title, '', a.id, standupId, row.id);
      }
    }
  }

  const agentNames = taskRows.map((r) => r.agent.name || r.agent.id);
  const kanbanTaskIds = [];
  for (const r of taskRows) {
    const k = db().prepare('SELECT id FROM kanban_tasks WHERE agent_delegation_task_id = ?').get(r.taskId);
    if (k) kanbanTaskIds.push(k.id);
  }

  let scheduledCount = 0;
  for (const { taskId, agent } of taskRows) {
    const task = db().prepare('SELECT * FROM agent_delegation_tasks WHERE id = ?').get(taskId);
    if (!task) continue;
    const kanbanRow = db().prepare('SELECT id FROM kanban_tasks WHERE agent_delegation_task_id = ?').get(taskId);
    const kanbanId = kanbanRow ? kanbanRow.id : null;
    let promptWithMemory = await getPromptWithMemoryInjected(agent.id, task.prompt);
    if (kanbanId) {
      promptWithMemory =
        `FIRST ACTION (before anything else): call the kanban_move_status tool with JSON:\n` +
        `  {\"task_id\": ${kanbanId}, \"new_status\": \"in_progress\"}\n\n` +
        promptWithMemory +
        `\n\n---\nIMPORTANT — Kanban finish:\nWhen you are done, call ONE of:\n  {\"task_id\": ${kanbanId}, \"new_status\": \"completed\"}\n  {\"task_id\": ${kanbanId}, \"new_status\": \"failed\"}\n---`;
    }
    const webhookUrl = `${baseUrl}/api/standups/cron-callback?standup_id=${standupId}&request_id=${encodeURIComponent(requestId)}&agent_id=${encodeURIComponent(agent.id)}&task_id=${taskId}`;
    const openclawAgentId = agent.openclaw_agent_id || agent.id;
    const result = await cronAddOneShotWebhook({
      name: `standup-${standupId}-${agent.id}-${taskId}`,
      agentId: openclawAgentId,
      message: promptWithMemory,
      webhookUrl,
    });
    if (result.ok) {
      scheduledCount++;
    } else {
      console.warn('[delegation] cron_add failed for', agent.id, result.error);
    }
    // If cron failed, task stays pending; processPendingDelegationTasks will run it via chat (fallback).
  }
  const pendingCount = taskRows.length - scheduledCount;
  return { requestId, count: taskRows.length, scheduledCount, pendingCount, agentNames, kanbanTaskIds };
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
  const context = getStandupContextForIntent(standupId, fullContext);
  const allocated = agentsMdContent && fullContext ? await classifyIntentAndAllocate(fullContext, agentsMdContent, context) : null;

  let count = 0;
  if (allocated && typeof allocated === 'object' && Object.keys(allocated).length > 0) {
    for (const a of agents) {
      const query = allocated[a.id?.toLowerCase()] ?? allocated[a.id];
      if (!query || typeof query !== 'string') continue;
      const prompt = buildDetailedPromptForAgent(query, a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      count++;
    }
  } else if (allocated === null && agents.length > 0) {
    for (const a of agents) {
      const prompt = buildDetailedPromptForAgent(fullContext, a.name || a.id, a.role);
      ins.run(standupId, requestId, a.id, prompt);
      count++;
    }
  } else if ((!allocated || Object.keys(allocated).length === 0) && agents.length > 0) {
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

  const lines = completed.map((t) => `**${t.agent_name}:**\n${truncatePreservingImages(t.response_content || '', 2000)}`);
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
  recoverStaleProcessingDelegations();
  const allPending = db().prepare('SELECT * FROM agent_delegation_tasks WHERE status = ? ORDER BY created_at LIMIT 20').all('pending');
  const pending = filterPipelineDelegationsForProcessing(allPending);
  const now = new Date().toISOString();

  async function runOne(task) {
    if (runningDelegationIds.has(task.id)) return;
    const claim = db()
      .prepare(`UPDATE agent_delegation_tasks SET status = 'processing' WHERE id = ? AND status = 'pending'`)
      .run(task.id);
    if (!claim.changes) return;

    runningDelegationIds.add(task.id);
    task = db().prepare('SELECT * FROM agent_delegation_tasks WHERE id = ?').get(task.id);

    const agent = db().prepare('SELECT id, name, openclaw_agent_id FROM agents WHERE id = ?').get(task.to_agent_id);
    if (!agent) {
      db().prepare('UPDATE agent_delegation_tasks SET status = ?, error_message = ?, completed_at = ? WHERE id = ?').run('failed', 'Agent not found', now, task.id);
      if (isAgentWorkflowPrompt(task.prompt)) {
        completeAgentWorkflowKanbanForDelegation(task.id, { ok: false });
        failAgentWorkflowForDelegation({ ...task, status: 'failed', error_message: 'Agent not found' }).catch(() => {});
      } else {
        completePipelineKanbanForDelegation(task.id, { ok: false });
        failPipelineWorkflowForDelegation({ ...task, status: 'failed', error_message: 'Agent not found' });
      }
      runningDelegationIds.delete(task.id);
      return;
    }
    const openclawId = agent.openclaw_agent_id || agent.id;
    const sessionUser = `delegation-${task.id}`;
    const sessionKeyLine = `\n\nYour session key for this run is ${openclaw.sessionKeyFor(openclawId, sessionUser)}. Use this exact sessionKey when calling sessions_history. If sessions_history returns empty, the conversation is in the messages above—proceed with those.`;
    let promptWithMemory = await getPromptWithMemoryInjected(task.to_agent_id, task.prompt);
    promptWithMemory = promptWithMemory + sessionKeyLine;
    const kanbanRow = db().prepare('SELECT id FROM kanban_tasks WHERE agent_delegation_task_id = ?').get(task.id);
    if (kanbanRow) {
      promptWithMemory =
        `FIRST ACTION (before anything else): call the kanban_move_status tool with JSON:\n` +
        `  {\"task_id\": ${kanbanRow.id}, \"new_status\": \"in_progress\"}\n\n` +
        promptWithMemory +
        `\n\n---\nIMPORTANT — Kanban finish:\nWhen you are done, call ONE of:\n  {\"task_id\": ${kanbanRow.id}, \"new_status\": \"completed\"}\n  {\"task_id\": ${kanbanRow.id}, \"new_status\": \"failed\"}\n---`;
    }
    try {
      const isDiscovery = String(task.to_agent_id).toLowerCase() === 'jobdiscovery';
      const discoveryTimeout = Number(process.env.OPENCLAW_DISCOVERY_TIMEOUT_MS || 900000);
      const { content } = await openclaw.chatCompletions(
        openclawId,
        [{ role: 'user', content: promptWithMemory }],
        sessionUser,
        false,
        isDiscovery ? { timeoutMs: discoveryTimeout } : {}
      );
      const responseText = normalizeReplyContent(content) || '(no response)';
      db().prepare('UPDATE agent_delegation_tasks SET status = ?, response_content = ?, completed_at = ? WHERE id = ?').run('completed', responseText, now, task.id);
      if (isAgentWorkflowPrompt(task.prompt)) {
        completeAgentWorkflowKanbanForDelegation(task.id, { ok: true });
        try {
          await maybeAdvanceAgentWorkflow({ ...task, status: 'completed', response_content: responseText });
        } catch (wfErr) {
          console.warn('[agent-workflow] advance:', wfErr.message);
        }
      } else {
        completePipelineKanbanForDelegation(task.id, { ok: true });
        try {
          await maybeHandoffJobPipeline({ ...task, status: 'completed', response_content: responseText });
        } catch (handoffErr) {
          console.warn('[job-pipeline] handoff:', handoffErr.message);
        }
      }
      appendDelegationResponseToAgentChat(task.to_agent_id, extractTaskSummaryFromPrompt(task.prompt), responseText);
      const summary = extractTaskSummaryFromPrompt(task.prompt);
      await appendToAgentMemory(task.to_agent_id, summary);
    } catch (err) {
      db().prepare('UPDATE agent_delegation_tasks SET status = ?, error_message = ?, completed_at = ? WHERE id = ?').run('failed', err.message, now, task.id);
      if (isAgentWorkflowPrompt(task.prompt)) {
        completeAgentWorkflowKanbanForDelegation(task.id, { ok: false });
        await failAgentWorkflowForDelegation({ ...task, status: 'failed', error_message: err.message });
      } else {
        completePipelineKanbanForDelegation(task.id, { ok: false });
        failPipelineWorkflowForDelegation({ ...task, status: 'failed', error_message: err.message }, { error: err.message });
      }
    } finally {
      runningDelegationIds.delete(task.id);
    }
  }

  await Promise.allSettled(pending.map((task) => runOne(task)));

  const allRequestIds = db().prepare('SELECT DISTINCT request_id FROM agent_delegation_tasks').all().map((r) => r.request_id);
  for (const requestId of allRequestIds) {
    postCallbackForRequestId(requestId);
  }
}
