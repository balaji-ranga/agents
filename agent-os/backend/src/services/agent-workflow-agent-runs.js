/**
 * Workflow run queries for the Workflow Builder agent — factual DB lookups, no LLM guessing.
 */
import * as store from './agent-workflow-store.js';
import {
  resolveWorkflowForTrigger,
  summarizeRunForAgent,
  findLatestFailedRun,
} from './agent-workflow-chat-tools.js';
import { extractWorkflowReferenceFromMessage } from './agent-workflow-agent-describe.js';

function extractWorkflowNameFromRunQuery(message) {
  const t = String(message || '');
  const ref = extractWorkflowReferenceFromMessage(t);

  const patterns = [
    /(?:failed\s+run\s+of|failure\s+of)\s+(?:the\s+)?(?:workflow\s+)?[`"']?([a-zA-Z0-9_-]+)[`"']?/i,
    /(?:run\s+of|runs?\s+for)\s+(?:the\s+)?(?:workflow\s+)?[`"']?([a-zA-Z0-9_-]+)[`"']?/i,
    /(?:why|how)\s+(?:did|does|was)\s+(?:the\s+)?(?:workflow\s+)?[`"']?([a-zA-Z0-9_-]+)[`"']?\s+fail/i,
    /(?:workflow\s+)?[`"']?([a-zA-Z0-9_-]+)[`"']?\s+(?:workflow\s+)?fail(?:ed|ure)?/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1] && !/^(the|a|an|this|that|recent|latest|last|most|why|what|run|workflow)$/i.test(m[1])) {
      return m[1].trim();
    }
  }

  for (const m of t.matchAll(/`([^`]+)`/g)) {
    const name = m[1].trim();
    if (name.length > 1) return name;
  }

  return ref.name || null;
}

export function parseFailedRunQueryIntent(message) {
  const t = String(message || '').trim();
  if (!t) return null;

  const asksFailure =
    /(?:recent|latest|last|most recent)\s+failed\s+run/i.test(t) ||
    /failed\s+run\s+of/i.test(t) ||
    /(?:why|how)\s+(?:did|does|was)\s+.+\s+fail/i.test(t) ||
    /(?:what|which)\s+(?:is|was)\s+(?:the\s+)?(?:recent|latest|last)?\s*failed/i.test(t) ||
    /(?:inspect|show|check|explain)\s+(?:the\s+)?(?:recent|latest|last)?\s*failed/i.test(t);

  if (!asksFailure) return null;

  const workflow_query = extractWorkflowNameFromRunQuery(t);
  const ref = extractWorkflowReferenceFromMessage(t);

  return {
    workflow_query: workflow_query || ref.name || ref.workflow_id || null,
    workflow_id: ref.workflow_id || null,
    inspect: true,
  };
}

export function parseListRunsQueryIntent(message) {
  const t = String(message || '').trim();
  if (!t) return null;
  if (!/(?:list|show|recent)\s+(?:workflow\s+)?runs?/i.test(t)) return null;

  const workflow_query = extractWorkflowNameFromRunQuery(t);
  const ref = extractWorkflowReferenceFromMessage(t);
  return {
    workflow_query: workflow_query || ref.name || ref.workflow_id || null,
    workflow_id: ref.workflow_id || null,
  };
}

export function resolveWorkflowForRunQuery(ownerUserId, { workflow_id, workflow_query } = {}) {
  if (workflow_id) {
    const byId = store.getDefinition(workflow_id, ownerUserId);
    if (byId) return byId;
  }
  if (workflow_query) {
    const byName = resolveWorkflowForTrigger(ownerUserId, {
      workflow_id: workflow_query,
      workflow_name: workflow_query,
      message: workflow_query,
    });
    if (byName) return byName;
  }
  return null;
}

export function listRunsSummaryForAgent(ownerUserId, definitionId, limit = 15) {
  return store.listRuns(definitionId, ownerUserId, limit).map((r) => ({
    run_id: r.id,
    run_number: r.run_number,
    status: r.status,
    progress_pct: r.progress_pct,
    error_message: r.error_message || null,
    started_at: r.started_at,
    completed_at: r.completed_at,
  }));
}

export function formatRunFailureReply(def, runSummary) {
  if (!def) return 'Workflow not found.';
  if (!runSummary) {
    return `No failed runs found for workflow **${def.name}** (id: \`${def.id}\`).`;
  }

  const lines = [
    `**${def.name}** — failed run **#${runSummary.run_number}** (run id: ${runSummary.run_id})`,
    `- Status: ${runSummary.status}`,
    `- Started: ${runSummary.started_at || '—'}`,
    `- Completed: ${runSummary.completed_at || '—'}`,
  ];

  if (runSummary.error_message) {
    lines.push(`- Run error: ${runSummary.error_message}`);
  }

  const failedSteps = (runSummary.steps || []).filter((s) => s.status === 'failed');
  if (failedSteps.length) {
    lines.push('', '**Failed step(s):**');
    for (const s of failedSteps) {
      lines.push(`- **${s.node_label || s.node_id}** (\`${s.node_type || 'step'}\`): ${s.error_message || 'failed'}`);
      if (s.output_preview) lines.push(`  - Output preview: ${s.output_preview}`);
    }
  } else if (!runSummary.error_message) {
    lines.push('', '_No step-level failure recorded — check run logs in the workflow UI._');
  }

  return lines.join('\n');
}

export function formatRunsListReply(def, runs) {
  if (!def) return 'Workflow not found.';
  if (!runs?.length) return `No runs yet for **${def.name}** (id: \`${def.id}\`).`;

  const lines = [`Recent runs for **${def.name}** (id: \`${def.id}\`):`];
  for (const r of runs) {
    lines.push(
      `- #${r.run_number} (id ${r.run_id}) | ${r.status}${r.error_message ? ` | ${r.error_message.slice(0, 100)}` : ''}`
    );
  }
  return lines.join('\n');
}

export function formatRunContextBlock(def, runs, { maxRuns = 10 } = {}) {
  if (!def || !runs?.length) return '';
  const slice = runs.slice(0, maxRuns);
  const latestFailed = slice.find((r) => r.status === 'failed');
  const lines = [
    `Recent runs for ${def.name} (AUTHORITATIVE — do not invent other run numbers):`,
    ...slice.map(
      (r) =>
        `- #${r.run_number} (id ${r.id}) | ${r.status}${r.error_message ? ` | error: ${String(r.error_message).slice(0, 120)}` : ''}`
    ),
  ];
  if (latestFailed) {
    lines.push(`Latest failed run: #${latestFailed.run_number} (id ${latestFailed.id})`);
  }
  return lines.join('\n');
}

/**
 * Deterministic response for "latest failed run of X" — inspect_run from DB, no LLM.
 */
export async function tryFailedRunQueryResponse(ownerUserId, workflowId, message) {
  const intent = parseFailedRunQueryIntent(message);
  if (!intent) return null;

  const def =
    resolveWorkflowForRunQuery(ownerUserId, intent) ||
    (workflowId ? store.getDefinition(workflowId, ownerUserId) : null);

  if (!def) {
    const q = intent.workflow_query || 'workflow';
    return {
      reply: `No workflow matched "${q}". Use the exact workflow name or id from the workflows list.`,
      workflow_id: workflowId,
      actions_applied: [],
    };
  }

  const { run } = findLatestFailedRun(ownerUserId, {
    workflow_id: def.id,
  });

  if (!run) {
    return {
      reply: formatRunFailureReply(def, null),
      workflow_id: def.id,
      workflow: def,
      actions_applied: [{ action: 'list_runs', ok: true, workflow_id: def.id, runs: listRunsSummaryForAgent(ownerUserId, def.id) }],
    };
  }

  const summary = summarizeRunForAgent(run);
  return {
    reply: formatRunFailureReply(def, summary),
    workflow_id: def.id,
    workflow: def,
    actions_applied: [{ action: 'inspect_run', ok: true, run: summary }],
  };
}

export async function tryListRunsQueryResponse(ownerUserId, workflowId, message) {
  const intent = parseListRunsQueryIntent(message);
  if (!intent) return null;

  const def =
    resolveWorkflowForRunQuery(ownerUserId, intent) ||
    (workflowId ? store.getDefinition(workflowId, ownerUserId) : null);

  if (!def) {
    return {
      reply: `No workflow matched "${intent.workflow_query || 'workflow'}".`,
      workflow_id: workflowId,
      actions_applied: [],
    };
  }

  const runs = listRunsSummaryForAgent(ownerUserId, def.id, 20);
  return {
    reply: formatRunsListReply(def, runs),
    workflow_id: def.id,
    workflow: def,
    actions_applied: [{ action: 'list_runs', ok: true, workflow_id: def.id, runs }],
  };
}
