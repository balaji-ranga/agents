/**
 * Chat-triggerable agent workflows — list/trigger helpers for COO tools and CEO chat.
 */
import { getDb } from '../db/schema.js';
import { getBalaCeoAuthId } from './job-applicant-ceo.js';
import * as store from './agent-workflow-store.js';
import { tryTriggerWorkflowFromChat, startAgentWorkflowRun } from './agent-workflow-runner.js';

export function resolveWorkflowOwnerUserId(req, body = {}, resolveAuthenticatedCeoUserId) {
  const explicit = body?.ceo_user_id ?? body?.ceoUserId ?? body?.owner_user_id;
  if (explicit) return String(explicit).trim();
  if (req?.authUser && resolveAuthenticatedCeoUserId) {
    return resolveAuthenticatedCeoUserId(req, body);
  }
  return getBalaCeoAuthId();
}

export function listChatTriggerableWorkflows(ownerUserId) {
  return listPublishedWorkflows(ownerUserId, { chatOnly: true });
}

function formatWorkflowForAgent(w) {
  const chatTriggerable =
    Array.isArray(w.trigger_modes) &&
    w.trigger_modes.includes('chat') &&
    String(w.chat_trigger_phrase || '').trim();
  return {
    id: w.id,
    name: w.name,
    description: w.description || '',
    chat_trigger_phrase: w.chat_trigger_phrase || '',
    trigger_modes: w.trigger_modes || [],
    schedule_cron: w.schedule_cron || '',
    status: w.status,
    paused: !!w.paused,
    chat_triggerable: !!chatTriggerable,
    trigger_hint: chatTriggerable
      ? `Use agent_workflow_trigger with message "${w.chat_trigger_phrase}" or workflow_id "${w.id}"`
      : `Use agent_workflow_trigger with workflow_id "${w.id}"`,
  };
}

/** List published workflows for COO tools. Default: all published; chatOnly limits to chat phrase triggers. */
export function listPublishedWorkflows(ownerUserId, { chatOnly = false } = {}) {
  let workflows = store
    .listDefinitions(ownerUserId)
    .filter((w) => w.status === 'published' && !w.paused);
  if (chatOnly) {
    workflows = workflows.filter(
      (w) =>
        Array.isArray(w.trigger_modes) &&
        w.trigger_modes.includes('chat') &&
        String(w.chat_trigger_phrase || '').trim()
    );
  }
  return workflows.map(formatWorkflowForAgent);
}

function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

function tokenize(s) {
  return normText(s)
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Score how well a workflow matches a natural-language enquiry. */
function scoreWorkflowMatch(w, queryNorm, tokens) {
  const hay = normText([w.id, w.name, w.description, w.chat_trigger_phrase].join(' '));
  if (!queryNorm) return 0;
  let score = 0;
  if (hay.includes(queryNorm)) score += 10;
  if (normText(w.name).includes(queryNorm) || normText(w.id).includes(queryNorm)) score += 8;
  if (normText(w.description).includes(queryNorm)) score += 6;
  if (normText(w.chat_trigger_phrase).includes(queryNorm)) score += 5;
  for (const t of tokens) {
    if (hay.includes(t)) score += 2;
  }
  return score;
}

/**
 * Find published workflows matching a description or natural-language query (COO tool).
 */
export function enquireWorkflows(ownerUserId, query, { limit = 10, all = false } = {}) {
  const q = String(query || '').trim();
  const queryNorm = normText(q);
  const tokens = tokenize(q);

  if (all || queryNorm === 'all' || queryNorm === '*') {
    const matches = listPublishedWorkflows(ownerUserId).slice(0, Math.min(limit, 50));
    return { query: q || 'all', matches, count: matches.length };
  }

  if (!queryNorm) {
    return { query: q, matches: [], count: 0 };
  }

  const published = store
    .listDefinitions(ownerUserId)
    .filter((w) => w.status === 'published' && !w.paused);

  const matches = published
    .map((w) => {
      const score = scoreWorkflowMatch(w, queryNorm, tokens);
      const formatted = formatWorkflowForAgent(w);
      return { ...formatted, score };
    })
    .filter((w) => w.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 25));

  return { query: q, matches, count: matches.length };
}

/** Resolve a workflow by id, name (fuzzy), or chat phrase substring. */
export function resolveWorkflowForTrigger(ownerUserId, { workflow_id, workflow_name, name, message } = {}) {
  const id = String(workflow_id || '').trim();
  if (id) {
    const byId = store.getDefinition(id, ownerUserId);
    if (byId) return byId;
  }

  const nameQuery = String(workflow_name || name || '')
    .trim()
    .toLowerCase();
  if (nameQuery) {
    const all = store.listDefinitions(ownerUserId);
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
    const nq = norm(nameQuery);
    let match =
      all.find((w) => w.id.toLowerCase() === nameQuery) ||
      all.find((w) => w.name.toLowerCase() === nameQuery) ||
      all.find((w) => norm(w.name) === nq) ||
      all.find((w) => norm(w.id) === nq) ||
      all.find((w) => w.name.toLowerCase().includes(nameQuery) || w.id.toLowerCase().includes(nameQuery));
    if (match) return match;
  }

  const msg = String(message || '').trim();
  if (msg) {
    const byPhrase = store.findPublishedByChatPhrase(ownerUserId, msg);
    if (byPhrase) return byPhrase;
    const lower = msg.toLowerCase();
    for (const w of listChatTriggerableWorkflows(ownerUserId)) {
      const phrase = String(w.chat_trigger_phrase || '').toLowerCase();
      if (phrase && lower.includes(phrase)) {
        return store.getDefinition(w.id, ownerUserId);
      }
    }
  }

  return null;
}

export function parseRunWorkflowIntent(message) {
  const trimmed = String(message || '').trim();
  const m = trimmed.match(
    /^(?:please\s+)?(?:run|start|trigger|execute)\s+(?:the\s+)?(?:workflow\s+)?["']?(.+?)["']?\s*$/i
  );
  return m ? m[1].trim() : null;
}

/** Resolve a run by numeric id or run_number within a workflow. */
export function resolveRunForOwner(
  ownerUserId,
  { run_id, runId, run_number, runNumber, workflow_id, workflowId, definition_id } = {}
) {
  const explicitId = Number(run_id ?? runId);
  if (explicitId) return store.getRun(explicitId, ownerUserId);

  const defId = String(workflow_id || workflowId || definition_id || '').trim();
  const num = Number(run_number ?? runNumber);
  if (defId && num) {
    const row = getDb()
      .prepare(
        `SELECT id FROM agent_workflow_runs
         WHERE definition_id = ? AND owner_user_id = ? AND run_number = ?`
      )
      .get(defId, ownerUserId, num);
    if (row) return store.getRun(row.id, ownerUserId);
  }
  if (defId) {
    const runs = store.listRuns(defId, ownerUserId, 1);
    if (runs[0]) return store.getRun(runs[0].id, ownerUserId);
  }
  return null;
}

export function summarizeRunForAgent(run) {
  if (!run) return null;
  return {
    run_id: run.id,
    run_number: run.run_number,
    definition_id: run.definition_id,
    definition_name: run.definition_name,
    status: run.status,
    progress_pct: run.progress_pct,
    error_message: run.error_message,
    started_at: run.started_at,
    completed_at: run.completed_at,
    steps: (run.steps || []).map((s) => ({
      node_id: s.node_id,
      node_label: s.node_label,
      node_type: s.node_type,
      status: s.status,
      error_message: s.error_message,
      output_preview:
        (typeof s.output?.text === 'string' && s.output.text.slice(0, 300)) ||
        (s.output_json && String(s.output_json).slice(0, 300)) ||
        null,
    })),
  };
}

export async function waitForRunTerminal(ownerUserId, runId, maxMs = 45000, pollMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const run = store.getRun(runId, ownerUserId);
    if (!run) return null;
    if (['completed', 'failed', 'paused', 'cancelled'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return store.getRun(runId, ownerUserId);
}

/**
 * Fast-path natural-language commands for the Workflow Builder chat (no LLM).
 */
export function extractWorkflowIdFromText(message) {
  const t = String(message || '');
  const patterns = [
    /\bid\s*[:=]\s*["']?([a-z0-9][a-z0-9_-]*)["']?/i,
    /\bworkflow\s+id\s*[:=]?\s*["']?([a-z0-9][a-z0-9_-]*)["']?/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseStatusChangeIntent(t, workflowId) {
  const toDraft =
    /(?:change|set)\s+(?:the\s+)?status(?:\s+of)?(?:\s+(?:workflow\s+)?(?:id\s*[:=]\s*)?["']?([^"'\n]+?)["']?)?\s+to\s+draft/i.test(
      t
    ) ||
    /(?:make|set)\s+(?:workflow\s+)?(?:id\s*[:=]\s*)?["']?([^"'\n]+?)["']?\s+(?:a\s+)?draft/i.test(t) ||
    /(?:unpublish|revert)\s+(?:workflow\s+)?(?:id\s*[:=]\s*)?["']?([^"'\n]+?)["']?/i.test(t);

  if (!toDraft && !/draft/i.test(t)) return null;
  if (!/(?:draft|unpublish|revert)/i.test(t)) return null;

  const explicitId = extractWorkflowIdFromText(t);
  let m = t.match(
    /(?:change|set)\s+(?:the\s+)?status\s+of\s+(?:id\s*[:=]\s*)?["']?([a-z0-9][a-z0-9_-]*)["']?\s+to\s+draft/i
  );
  if (m) {
    return { cmd: 'unpublish_workflow', workflow_id: m[1].trim() };
  }

  m = t.match(/(?:change|set)\s+(?:the\s+)?status\s+(?:of\s+)?["']?([^"'\n]+?)["']?\s+to\s+draft/i);
  if (m) {
    const target = m[1].trim();
    const id = explicitId || (/^[a-z0-9][a-z0-9_-]*$/i.test(target) ? target : null);
    return {
      cmd: 'unpublish_workflow',
      workflow_id: id || workflowId || undefined,
      workflow_name: id ? undefined : target,
    };
  }

  m = t.match(/(?:make|set)\s+(?:workflow\s+)?["']?([^"'\n]+?)["']?\s+(?:to\s+)?draft/i);
  if (m) {
    const target = m[1].trim();
    const id = explicitId || (/^[a-z0-9][a-z0-9_-]*$/i.test(target) ? target : null);
    return {
      cmd: 'unpublish_workflow',
      workflow_id: id || workflowId || undefined,
      workflow_name: id ? undefined : target,
    };
  }

  if (explicitId && /draft|unpublish|revert/i.test(t)) {
    return { cmd: 'unpublish_workflow', workflow_id: explicitId };
  }

  return null;
}

export function parseWorkflowAgentCommand(message, { workflowId = null } = {}) {
  const t = String(message || '').trim();
  if (!t) return null;

  const statusIntent = parseStatusChangeIntent(t, workflowId);
  if (statusIntent) return statusIntent;

  const runTarget = parseRunWorkflowIntent(t);
  if (runTarget) return { cmd: 'trigger_workflow', workflow_name: runTarget, workflow_id: workflowId };

  let m = t.match(/^(?:test|debug)\s+(?:workflow\s+)?["']?(.+?)["']?\s*$/i);
  if (m) return { cmd: 'test_workflow', workflow_name: m[1].trim(), workflow_id: workflowId };

  m = t.match(/^(?:reload|refresh|open)\s+(?:workflow\s+)?["']?(.+?)["']?\s*$/i);
  if (m) return { cmd: 'open_workflow', workflow_name: m[1].trim() };

  if (/^(?:reload|refresh)\s*(?:workflow|graph)?\s*$/i.test(t)) {
    return { cmd: 'reload_workflow', workflow_id: workflowId };
  }

  m = t.match(/^(?:pause)\s+(?:workflow\s+)?["']?(.+?)["']?\s*$/i);
  if (m) return { cmd: 'pause_workflow', workflow_name: m[1].trim(), workflow_id: workflowId };

  m = t.match(/^(?:resume|unpause)\s+(?:workflow\s+)?["']?(.+?)["']?\s*$/i);
  if (m) return { cmd: 'resume_workflow', workflow_name: m[1].trim(), workflow_id: workflowId };

  m = t.match(/^(?:pause)\s+(?:all\s+)?runs?\s*$/i);
  if (m) return { cmd: 'pause_all_runs', workflow_id: workflowId };

  m = t.match(/^(?:pause)\s+run\s+#?(\d+)\s*$/i);
  if (m) return { cmd: 'pause_run', run_number: Number(m[1]), workflow_id: workflowId };

  m = t.match(/^(?:stop|cancel|delete)\s+run\s+#?(\d+)\s*$/i);
  if (m) return { cmd: 'stop_run', run_number: Number(m[1]), workflow_id: workflowId };

  m = t.match(/^(?:inspect|status|show|check)\s+run\s+#?(\d+)\s*$/i);
  if (m) return { cmd: 'inspect_run', run_number: Number(m[1]), workflow_id: workflowId };

  m = t.match(/^(?:inspect|status)\s+(?:latest|last)\s+run\s*$/i);
  if (m) return { cmd: 'inspect_run', workflow_id: workflowId };

  m = t.match(/^(?:unpublish|revert\s+to\s+draft|make\s+draft|set\s+to\s+draft)(?:\s+(?:workflow\s+)?)?["']?(.+?)["']?\s*$/i);
  if (m) {
    const name = (m[1] || '').trim();
    return { cmd: 'unpublish_workflow', workflow_name: name || undefined, workflow_id: workflowId };
  }
  if (/^(?:unpublish|revert\s+to\s+draft|make\s+draft)\s*$/i.test(t)) {
    return { cmd: 'unpublish_workflow', workflow_id: workflowId };
  }

  return null;
}

/**
 * Start a workflow by chat phrase match, name, or explicit workflow_id.
 */
export async function triggerAgentWorkflowForOwner(
  ownerUserId,
  { message = '', workflow_id, workflow_name, name, input, actor } = {}
) {
  const msg = String(message || input || '').trim();
  const def = resolveWorkflowForTrigger(ownerUserId, {
    workflow_id,
    workflow_name: workflow_name || name,
    message: msg,
  });

  if (def) {
    if (!store.isWorkflowTriggerable(def)) {
      throw new Error(`Workflow "${def.name}" (${def.id}) is not runnable (draft, paused, or unpublished)`);
    }
    return startAgentWorkflowRun(def.id, ownerUserId, {
      trigger: 'chat',
      input: msg || `Triggered: ${def.name}`,
      actor,
    });
  }

  if (!msg) throw new Error('message, workflow name, or workflow_id required');

  const run = await tryTriggerWorkflowFromChat(ownerUserId, msg, actor);
  if (!run) {
    const available = listChatTriggerableWorkflows(ownerUserId);
    const all = store.listDefinitions(ownerUserId).filter((w) => w.status === 'published');
    const hints = all
      .map((w) => `"${w.name}" (id: ${w.id}${w.chat_trigger_phrase ? `, chat: "${w.chat_trigger_phrase}"` : ''})`)
      .join('; ');
    throw new Error(
      hints
        ? `No workflow matched. Published workflows: ${hints}`
        : 'No published workflows found for this CEO'
    );
  }
  return run;
}
