/**
 * Execute published agent workflows: agent nodes, tool nodes, parallel branches.
 * Integrates with delegation queue and Kanban (similar to job pipeline, separate tags).
 */
import { getDb } from '../db/schema.js';
import * as store from './agent-workflow-store.js';
import {
  AGENT_WORKFLOW_TAG,
  buildAgentWorkflowDescription,
  createAgentWorkflowKanbanTask,
  createCeoApprovalKanbanTask,
  isAgentWorkflowPrompt,
  isWorkflowCeoApprovalDescription,
  parseAgentWorkflowMeta,
  upsertCompletedStepKanban,
} from './agent-workflow-kanban.js';
import { getToolMeta } from './content-tools-meta.js';
import { processPendingDelegationTasks } from './delegation-queue.js';
import { resolveNodeInputs, resolveInputText, storeNodeOutput } from './agent-workflow-io.js';
import { executeEmailTask, executeApiTask } from './agent-workflow-tasks.js';
import { executeExternalAgentTask } from './agent-workflow-external-agent.js';
import { executeBrainTask } from './agent-workflow-brain.js';
import { executeCustomScriptTask } from './custom-scripts.js';
import { getTaskTypeDef } from './agent-workflow-task-catalog.js';
import { evaluateCondition } from './agent-workflow-conditions.js';
import { validateWorkflowBrainCredentials } from './agent-workflow-brain-providers.js';
import { getMcpServerForWorkflow, callMcpServerTool, callMcpServerPrompt, callMcpServerResource } from './mcp-servers.js';
import { parseMcpAuthFromNodeConfig } from './mcp-auth.js';
import {
  registerPendingListener,
  startPersistentListen,
  clearPendingListener,
  cancelAllListenersForRun,
  stopPersistentListen,
} from './agent-workflow-event-listener.js';
import { resolveSseStreamUrl } from './sse-stream.js';
import { getDownstreamNodeIds } from './agent-workflow-graph-utils.js';
import { getPublicBaseUrl } from '../config/public-url.js';
import { executeSubWorkflowTask } from './agent-workflow-sub-workflow.js';
import {
  resolveNodeTimeoutConfig,
  withNodeTimeout,
  isNodeTimeoutError,
  buildTimeoutFallbackOutputs,
  DEFAULT_NODE_TIMEOUT_MS,
} from './agent-workflow-node-timeout.js';

function db() {
  return getDb();
}

function getBackendBaseUrl() {
  return getPublicBaseUrl();
}

function parseContext(row) {
  try {
    return JSON.parse(row?.context_json || '{}');
  } catch {
    return {};
  }
}

function saveContext(runId, context) {
  db()
    .prepare(`UPDATE agent_workflow_runs SET context_json = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(context), runId);
}

function getExpectedNodeCount(runId) {
  const runRow = db().prepare('SELECT definition_id FROM agent_workflow_runs WHERE id = ?').get(runId);
  if (!runRow) return 1;
  const def = store.getDefinition(runRow.definition_id);
  const graph = def?.published_graph || def?.draft_graph || { nodes: [] };
  return Math.max(1, graph.nodes?.length || 1);
}

function updateRunProgress(runId) {
  const expected = getExpectedNodeCount(runId);
  const row = db()
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('completed','skipped','failed') THEN 1
                  WHEN status IN ('in_progress','listening') THEN 0.5
                  ELSE 0 END) AS weighted
       FROM agent_workflow_run_steps WHERE run_id = ?`
    )
    .get(runId);
  const pct = Math.min(100, Math.round(((row?.weighted || 0) / expected) * 100));
  db().prepare(`UPDATE agent_workflow_runs SET progress_pct = ?, updated_at = datetime('now') WHERE id = ?`).run(pct, runId);
  return pct;
}

function ensureWorkflowStandup() {
  let row = db().prepare(`SELECT id FROM standups WHERE source = 'agent_workflow' ORDER BY id DESC LIMIT 1`).get();
  if (!row) {
    db()
      .prepare(
        `INSERT INTO standups (scheduled_at, status, source, title) VALUES (datetime('now'), 'active', 'agent_workflow', 'Agent Workflows')`
      )
      .run();
    row = db().prepare(`SELECT id FROM standups WHERE source = 'agent_workflow' ORDER BY id DESC LIMIT 1`).get();
  }
  return row.id;
}

function getGraphForRun(runId) {
  const run = db().prepare('SELECT definition_id FROM agent_workflow_runs WHERE id = ?').get(runId);
  const def = store.getDefinition(run.definition_id);
  return def?.published_graph || def?.draft_graph || { nodes: [], edges: [] };
}

function getNode(graph, nodeId) {
  return graph.nodes.find((n) => n.id === nodeId);
}

function getIncomingEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.target === nodeId);
}

function getOutgoingEdges(graph, nodeId) {
  return graph.edges.filter((e) => e.source === nodeId);
}

function isWhileLoopBodyNode(graph, nodeId) {
  for (const n of graph.nodes || []) {
    if (n.type !== 'while') continue;
    if (getWhileLoopBodyNodeIds(graph, n.id).has(nodeId)) return true;
  }
  return false;
}

function getUpstreamWhileNode(graph, nodeId) {
  for (const n of graph.nodes || []) {
    if (n.type !== 'while') continue;
    if (getWhileLoopBodyNodeIds(graph, n.id).has(nodeId)) return n;
  }
  return null;
}

function getLatestStepRow(runId, nodeId) {
  return db()
    .prepare(
      `SELECT id, status, iteration FROM agent_workflow_run_steps
       WHERE run_id = ? AND node_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(runId, nodeId);
}

function getStepRowForIteration(runId, nodeId, iteration) {
  return db()
    .prepare(
      `SELECT id, status FROM agent_workflow_run_steps
       WHERE run_id = ? AND node_id = ? AND iteration = ?`
    )
    .get(runId, nodeId, iteration);
}

function resolveLoopStepIteration(node, graph, context) {
  if (node.type === 'while') {
    const prev = context.while_loops?.[node.id] || 0;
    return prev + 1;
  }
  const whileNode = getUpstreamWhileNode(graph, node.id);
  if (whileNode) return context.while_loops?.[whileNode.id] || 1;
  return 1;
}

/** Set during executeNode so upsertStep can append per-iteration rows for while loops. */
let activeStepMeta = null;

/** Nodes reachable from a while node's loop handle (body), excluding the while itself. */
function getWhileLoopBodyNodeIds(graph, whileNodeId) {
  const body = new Set();
  const stack = getOutgoingEdges(graph, whileNodeId)
    .filter((e) => (e.sourceHandle || 'default') === 'loop')
    .map((e) => e.target);
  while (stack.length) {
    const id = stack.pop();
    if (!id || id === whileNodeId || body.has(id)) continue;
    body.add(id);
    for (const e of getOutgoingEdges(graph, id)) {
      if (e.target !== whileNodeId) stack.push(e.target);
    }
  }
  return body;
}

function allPredecessorsComplete(runId, graph, nodeId) {
  const incoming = getIncomingEdges(graph, nodeId);
  if (!incoming.length) return true;

  const node = getNode(graph, nodeId);
  let loopBackSources = null;
  if (node?.type === 'while') {
    // Loop-back edges may come from any body node (not only the direct loop target),
    // e.g. while → maker → checker → parse → while. Skip those on first entry.
    const bodyIds = getWhileLoopBodyNodeIds(graph, nodeId);
    loopBackSources = new Set(incoming.filter((e) => bodyIds.has(e.source)).map((e) => e.source));
  }

  for (const edge of incoming) {
    const step = getLatestStepRow(runId, edge.source);
    const srcNode = getNode(graph, edge.source);

    // Exclusive IF/While branches: skip edges for branches that were not taken
    if (srcNode && (srcNode.type === 'if' || srcNode.type === 'while') && step) {
      let branch = null;
      try {
        const out = typeof step.output_json === 'string' ? JSON.parse(step.output_json || '{}') : step.output_json;
        // steps table may not expose output_json on getLatestStepRow — reload
      } catch {
        /* ignore */
      }
    }

    if (!step) {
      if (loopBackSources?.has(edge.source)) continue;
      // IF/While source not executed yet — if another exclusive branch already completed this node path, wait
      if (srcNode && (srcNode.type === 'if' || srcNode.type === 'while')) {
        // source hasn't completed — cannot take this edge yet
        return false;
      }
      return false;
    }

    const isListen = srcNode?.type === 'sse_listen' || srcNode?.type === 'mcp_listen';
    if (isListen && step.status === 'listening') continue;
    if (!['completed', 'skipped'].includes(step.status)) return false;

    if (srcNode && (srcNode.type === 'if' || srcNode.type === 'while')) {
      const full = db()
        .prepare(`SELECT output_json FROM agent_workflow_run_steps WHERE id = ?`)
        .get(step.id);
      let branch = null;
      try {
        const out = JSON.parse(full?.output_json || '{}');
        branch = out.branch || out.text || null;
      } catch {
        branch = null;
      }
      const handle = edge.sourceHandle || 'default';
      if (branch != null && String(branch) !== String(handle)) {
        // This exclusive branch was not taken — do not block the target
        continue;
      }
    }
  }
  return true;
}

function buildStepInputRecord(node, graph, context) {
  const { resolved, summary } = resolveNodeInputs(node, graph, context);
  const outputSchema = node.data?.outputs || getTaskTypeDef(node.type)?.outputs || [];
  const record = {
    inputs: summary,
    resolved,
    outputs_schema: outputSchema,
  };
  if (node.type === 'agent') {
    record.prompt_template = node.data?.prompt || node.data?.instructions || '';
    record.resolved_prompt = resolveInputText(node, graph, context);
  }
  return record;
}

function buildStepOutputRecord(outputs) {
  if (typeof outputs === 'string') return { text: outputs, outputs: [{ id: 'text', value: outputs }] };
  const list = Object.entries(outputs || {}).map(([id, value]) => ({
    id,
    value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
  }));
  return { ...outputs, outputs: list };
}

function upsertStep(runId, node, status, extra = {}) {
  const label = node.data?.label || node.id;
  const meta = activeStepMeta || {};
  const graph = meta.graph;
  const context = meta.context;
  const isWhile = node.type === 'while';
  const isLoopBody = graph ? isWhileLoopBodyNode(graph, node.id) : false;
  const appendOnly = isWhile || isLoopBody;
  const iteration = appendOnly
    ? (extra.iteration ?? resolveLoopStepIteration(node, graph, context))
    : 1;

  const existing = appendOnly
    ? getStepRowForIteration(runId, node.id, iteration)
    : db()
        .prepare(`SELECT id FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ? AND iteration = 1`)
        .get(runId, node.id);

  if (existing) {
    db()
      .prepare(
        `UPDATE agent_workflow_run_steps SET status = ?, node_label = ?, input_json = COALESCE(?, input_json),
         output_json = COALESCE(?, output_json), delegation_task_id = COALESCE(?, delegation_task_id),
         kanban_task_id = COALESCE(?, kanban_task_id), started_at = COALESCE(started_at, datetime('now')),
         completed_at = ?, error_message = ?, node_type = ?, iteration = ?
         WHERE id = ?`
      )
      .run(
        status,
        label,
        extra.input != null ? JSON.stringify(extra.input) : null,
        extra.output != null ? JSON.stringify(extra.output) : null,
        extra.delegation_task_id ?? null,
        extra.kanban_task_id ?? null,
        ['completed', 'failed', 'skipped'].includes(status) ? new Date().toISOString() : null,
        extra.error_message ?? null,
        node.type,
        iteration,
        existing.id
      );
    updateRunProgress(runId);
    return existing.id;
  }
  db()
    .prepare(
      `INSERT INTO agent_workflow_run_steps (run_id, node_id, node_type, node_label, status, input_json, output_json,
       delegation_task_id, kanban_task_id, started_at, completed_at, error_message, iteration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`
    )
    .run(
      runId,
      node.id,
      node.type,
      label,
      status,
      extra.input != null ? JSON.stringify(extra.input) : null,
      extra.output != null ? JSON.stringify(extra.output) : null,
      extra.delegation_task_id ?? null,
      extra.kanban_task_id ?? null,
      ['completed', 'failed', 'skipped'].includes(status) ? new Date().toISOString() : null,
      extra.error_message ?? null,
      iteration
    );
  const stepId = db().prepare('SELECT id FROM agent_workflow_run_steps ORDER BY id DESC LIMIT 1').get()?.id;
  updateRunProgress(runId);
  return stepId;
}

async function invokeContentTool(toolName, body) {
  const row = getToolMeta(toolName);
  if (!row) throw new Error(`Tool not found: ${toolName}`);
  if (!row.enabled) throw new Error(`Tool disabled: ${toolName}`);
  const baseUrl = getBackendBaseUrl();
  let targetUrl = row.endpoint;
  if (targetUrl.startsWith('/')) targetUrl = baseUrl + targetUrl;
  const headers = { 'Content-Type': 'application/json', 'x-internal-test': '1' };
  const response = await fetch(targetUrl, {
    method: row.method || 'POST',
    headers,
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(120000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Tool ${toolName} failed (${response.status})`);
  return data;
}

function failRun(runId, message) {
  db()
    .prepare(
      `UPDATE agent_workflow_runs SET status = 'failed', error_message = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
    .run(message, runId);
}

/** Node types that can safely re-dispatch after a process restart. */
const RESUMABLE_IN_PROGRESS_TYPES = new Set([
  'brain',
  'api',
  'custom_script',
  'mcp_tool',
  'email',
  'externalAgent',
  'tool',
  'sub_workflow',
]);

/** Wait for external completion after restart (do not re-dispatch). */
const EXTERNAL_WAIT_TYPES = new Set(['agent', 'ceo_approval']);

/** Event listeners — leave status; separate restore may reconnect streams. */
const LISTEN_TYPES = new Set(['sse_listen', 'mcp_listen']);

/** Per-step remaining timeout after resume: `${runId}:${nodeId}` → ms */
const resumeTimeoutOverrides = new Map();

/** Wall clock when this process loaded — steps started before this are restart orphans. */
const PROCESS_STARTED_AT_MS = Date.now();

function stepStartedAtMs(step) {
  const raw = String(step?.started_at || '').trim();
  if (!raw) return Date.now();
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : Date.now();
}

function isRestartOrphanStep(step) {
  return stepStartedAtMs(step) < PROCESS_STARTED_AT_MS - 500;
}

function remainingTimeoutMsForStep(step, timeoutMs) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_NODE_TIMEOUT_MS;
  const elapsed = Math.max(0, Date.now() - stepStartedAtMs(step));
  return Math.max(1000, limit - elapsed);
}

function isPersistedStepTimedOut(step, timeoutMs) {
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_NODE_TIMEOUT_MS;
  return Date.now() - stepStartedAtMs(step) >= limit;
}

/**
 * Complete a timed node: race work against timeoutMs; on timeout either fail the run
 * or continue with defaultTimeoutOutput (timeoutAction=default_output).
 * After restart, resume may pass timeoutMsOverride = remaining time from original started_at.
 */
async function completeTimedNodeStep({
  runId,
  node,
  nodeId,
  def,
  runRow,
  context,
  inputRecord,
  work,
  kanban,
}) {
  const config = node.data?.taskConfig || node.data?.config || {};
  const { timeoutMs, timeoutAction, defaultOutput } = resolveNodeTimeoutConfig(config);
  const overrideKey = `${runId}:${node.id}`;
  const override = resumeTimeoutOverrides.get(overrideKey);
  if (override != null) resumeTimeoutOverrides.delete(overrideKey);
  const effectiveTimeout =
    override?.remainingTimeoutMs != null ? Number(override.remainingTimeoutMs) : timeoutMs;

  upsertStep(runId, node, 'in_progress', { input: inputRecord });
  try {
    const outputs = await withNodeTimeout(work(), effectiveTimeout);
    storeNodeOutput(context, node.id, outputs);
    saveContext(runId, context);
    upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
    if (kanban) {
      const meta = typeof kanban === 'function' ? kanban(outputs) : kanban;
      upsertCompletedStepKanban({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: meta.nodeLabel || node.data?.label || node.type,
        nodeType: node.type,
        agentId: null,
        ownerUserId: runRow.owner_user_id,
        summary: meta.summary || '',
        detail: meta.detail || {},
      });
    }
    updateRunProgress(runId);
    await advanceFromNode(runId, nodeId);
  } catch (err) {
    if (isNodeTimeoutError(err) && timeoutAction === 'default_output') {
      const outputs = buildTimeoutFallbackOutputs(node.type, defaultOutput, timeoutMs);
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', {
        output: buildStepOutputRecord(outputs),
        error_message: err.message,
      });
      if (kanban) {
        const meta = typeof kanban === 'function' ? kanban(outputs) : kanban;
        upsertCompletedStepKanban({
          runId,
          definitionId: def.id,
          definitionName: def.name,
          nodeId: node.id,
          nodeLabel: meta.nodeLabel || node.data?.label || node.type,
          nodeType: node.type,
          agentId: null,
          ownerUserId: runRow.owner_user_id,
          summary: `Timed out — continued with default output (${Math.round(timeoutMs / 1000)}s)`,
          detail: { ...(meta.detail || {}), timed_out: true, timeout_ms: timeoutMs },
        });
      }
      updateRunProgress(runId);
      await advanceFromNode(runId, nodeId);
      return;
    }
    upsertStep(runId, node, 'failed', { error_message: err.message });
    failRun(runId, err.message);
  }
}

function completeRun(runId) {
  updateRunProgress(runId);
  db()
    .prepare(
      `UPDATE agent_workflow_runs SET status = 'completed', completed_at = datetime('now'), progress_pct = 100, updated_at = datetime('now') WHERE id = ?`
    )
    .run(runId);
}

function buildAgentPrompt(runId, definitionId, definitionName, node, inputText, ownerUserId) {
  return [
    `${AGENT_WORKFLOW_TAG}${node.id}]`,
    `agent_wf_run_id: ${runId}`,
    `agent_wf_def_id: ${definitionId}`,
    `owner_user_id: ${ownerUserId}`,
    '',
    'This is an automated agent workflow step — NOT an interactive CEO session.',
    'Complete the task below, then finish your Kanban card.',
    '',
    `Workflow: ${definitionName}`,
    `Step: ${node.data?.label || node.id}`,
    '',
    '---',
    inputText,
    '---',
  ].join('\n');
}

/**
 * Start a new workflow run from published definition.
 */
export async function startAgentWorkflowRun(definitionId, ownerUserId, { trigger = 'manual', input = '', actor = null } = {}) {
  const def = store.getDefinition(definitionId, ownerUserId);
  if (!def) throw new Error('Workflow not found');
  if (def.paused) throw new Error('Workflow is paused — resume it before running');
  if (trigger === 'schedule') {
    if (!def.trigger_modes.includes('schedule')) {
      console.warn(`[agent-workflow] Blocked schedule run for ${definitionId} (schedule mode off)`);
      throw new Error('Schedule trigger is disabled for this workflow');
    }
    const scheduled = store.isWorkflowInScheduleRegistry(definitionId);
    if (!scheduled) {
      console.warn(`[agent-workflow] Blocked schedule run for ${definitionId} (not in schedule registry)`);
      throw new Error('Workflow is not scheduled');
    }
  }
  if (trigger === 'chat' && !def.trigger_modes.includes('chat')) {
    throw new Error('Chat trigger is disabled for this workflow');
  }
  if (trigger === 'event' && !def.trigger_modes.includes('event')) {
    throw new Error('Event trigger is disabled for this workflow');
  }
  if (def.status !== 'published' || !def.published_graph) {
    throw new Error('Workflow must be published before running');
  }

  const graph = def.published_graph;
  const brainErrors = validateWorkflowBrainCredentials(graph);
  if (brainErrors.length) {
    throw new Error(`Cannot run workflow: ${brainErrors.join('; ')}`);
  }
  const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
  if (!triggerNode) throw new Error('Published workflow has no trigger node');

  const runNumber =
    (db()
      .prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS n FROM agent_workflow_runs WHERE definition_id = ?')
      .get(definitionId)?.n) || 1;

  const standupId = ensureWorkflowStandup();
  const context = {
    initial_input: input,
    node_outputs: {},
    actor,
    workflow_variables: def.variables || {},
    variables: def.variables || {},
    definition_id: definitionId,
  };

  db()
    .prepare(
      `INSERT INTO agent_workflow_runs (run_number, definition_id, owner_user_id, status, trigger, context_json, standup_id)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`
    )
    .run(runNumber, definitionId, ownerUserId, trigger, JSON.stringify(context), standupId);

  const runId = db().prepare('SELECT id FROM agent_workflow_runs ORDER BY id DESC LIMIT 1').get()?.id;

  store.appendAudit(definitionId, {
    action: 'run_started',
    summary: `Run #${runNumber} started (${trigger})`,
    changedBy: actor?.id,
    changedByName: actor?.name,
  });

  upsertStep(runId, triggerNode, 'completed', {
    input: { trigger, initial_input: input },
    output: buildStepOutputRecord({ trigger_input: input || `Triggered via ${trigger}` }),
  });
  if (!context.node_outputs) context.node_outputs = {};
  context.node_outputs[triggerNode.id] = { trigger_input: input || `Triggered via ${trigger}`, text: input || `Triggered via ${trigger}` };
  saveContext(runId, context);
  updateRunProgress(runId);

  void advanceFromNode(runId, triggerNode.id)
    .catch((err) => {
      console.error(`[agent-workflow] run ${runId} advance failed:`, err);
      failRun(runId, err?.message || 'Workflow execution failed');
      updateRunProgress(runId);
    })
    .finally(() => {
      processPendingDelegationTasks().catch(() => {});
    });

  return store.getRun(runId, ownerUserId);
}

/**
 * Advance workflow execution from a completed node.
 * @param {string} [branchHandle] - for IF/While: only follow edges with matching sourceHandle
 */
export async function advanceFromNode(runId, fromNodeId, branchHandle = null) {
  const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
  if (!runRow || !['running'].includes(runRow.status)) return;

  const def = store.getDefinition(runRow.definition_id);
  const graph = def?.published_graph || { nodes: [], edges: [] };
  const context = parseContext(runRow);
  let outgoing = getOutgoingEdges(graph, fromNodeId);

  if (branchHandle != null) {
    outgoing = outgoing.filter((e) => (e.sourceHandle || 'default') === branchHandle);
  }

  if (!outgoing.length) {
    const anyPending = db()
      .prepare(`SELECT 1 FROM agent_workflow_run_steps WHERE run_id = ? AND status IN ('pending','in_progress','listening') LIMIT 1`)
      .get(runId);
    if (!anyPending) completeRun(runId);
    return;
  }

  for (const edge of outgoing) {
    await executeNode(runId, edge.target, graph, context, def, runRow);
  }
}

async function executeNode(runId, nodeId, graph, context, def, runRow) {
  const node = getNode(graph, nodeId);
  if (!node) return;

  if (!allPredecessorsComplete(runId, graph, nodeId)) return;

  const prevStepMeta = activeStepMeta;
  activeStepMeta = { graph, context };

  const dispatch = context._event_dispatch;
  const eventBranchIds = dispatch ? getDownstreamNodeIds(graph, dispatch.listenNodeId) : new Set();
  const isEventBranch = dispatch && eventBranchIds.has(nodeId);
  const isListenType = node.type === 'sse_listen' || node.type === 'mcp_listen';
  const isLoopBody = isWhileLoopBodyNode(graph, nodeId);
  const allowRerun = node.type === 'while' || isEventBranch || isLoopBody;
  const latest = getLatestStepRow(runId, nodeId);
  const loopIteration = allowRerun && (node.type === 'while' || isLoopBody)
    ? resolveLoopStepIteration(node, graph, context)
    : 1;
  const existing = allowRerun && (node.type === 'while' || isLoopBody)
    ? getStepRowForIteration(runId, nodeId, loopIteration)
    : latest;

  try {
  if (latest && ['completed', 'in_progress', 'failed'].includes(latest.status) && !allowRerun) return;
  if (existing && isEventBranch && !isListenType) {
    db().prepare(`DELETE FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?`).run(runId, nodeId);
  }
  if (existing && ['completed', 'in_progress'].includes(existing.status) && (node.type === 'while' || isLoopBody)) {
    return;
  }
  if (latest && latest.status === 'in_progress' && node.type !== 'ceo_approval' && !isListenType && !allowRerun) return;

  if (node.type === 'parallel') {
    upsertStep(runId, node, 'completed', { output: { parallel: true } });
    context.node_outputs = context.node_outputs || {};
    context.node_outputs[node.id] = 'parallel branch started';
    saveContext(runId, context);
    const children = getOutgoingEdges(graph, nodeId);
    await Promise.allSettled(children.map((e) => executeNode(runId, e.target, graph, context, def, runRow)));
    return;
  }

  if (node.type === 'merge') {
    upsertStep(runId, node, 'completed', { output: { merged: true } });
    context.node_outputs[node.id] = 'merged';
    saveContext(runId, context);
    await advanceFromNode(runId, nodeId);
    return;
  }

  if (node.type === 'if') {
    const cond = node.data?.taskConfig || node.data?.condition || {};
    const pass = evaluateCondition(cond, context);
    const branch = pass ? 'true' : 'false';
    const outputs = { result: pass, text: branch, branch };
    storeNodeOutput(context, node.id, outputs);
    saveContext(runId, context);
    upsertStep(runId, node, 'completed', {
      input: { condition: cond },
      output: buildStepOutputRecord(outputs),
    });
    updateRunProgress(runId);
    await advanceFromNode(runId, nodeId, branch);
    return;
  }

  if (node.type === 'while') {
    const cond = node.data?.taskConfig || node.data?.condition || {};
    const maxIter = Number(cond.maxIterations) || 10;
    context.while_loops = context.while_loops || {};
    const prev = context.while_loops[node.id] || 0;
    const pass = evaluateCondition(cond, context) && prev < maxIter;
    if (pass) {
      context.while_loops[node.id] = prev + 1;
      const outputs = { iterations: context.while_loops[node.id], text: 'loop', branch: 'loop' };
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', {
        input: { condition: cond, iteration: context.while_loops[node.id] },
        output: buildStepOutputRecord(outputs),
        iteration: context.while_loops[node.id],
      });
      updateRunProgress(runId);
      await advanceFromNode(runId, nodeId, 'loop');
    } else {
      const outputs = { iterations: prev, text: 'exit', branch: 'exit' };
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', {
        input: { condition: cond, iteration: prev },
        output: buildStepOutputRecord(outputs),
        iteration: prev + 1,
      });
      updateRunProgress(runId);
      await advanceFromNode(runId, nodeId, 'exit');
    }
    return;
  }

  if (node.type === 'brain') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    const ownerAuth = db()
      .prepare('SELECT id, role FROM platform_users WHERE id = ?')
      .get(runRow.owner_user_id) || { id: runRow.owner_user_id, role: 'ceo' };
    await completeTimedNodeStep({
      runId,
      node,
      nodeId,
      def,
      runRow,
      context,
      inputRecord,
      work: () => executeBrainTask(config, inputRecord.resolved, context, graph, { authUser: ownerAuth }),
      kanban: (outputs) => ({
        nodeLabel: node.data?.label || 'Brain',
        summary: (outputs.text || '').slice(0, 200),
        detail: {
          model: outputs.model_used,
          provider: outputs.provider,
          mcp_tools_available: outputs.mcp_tools_available,
          mcp_tool_calls: outputs.mcp_tool_calls,
          timed_out: outputs.timed_out || false,
        },
      }),
    });
    return;
  }

  if (node.type === 'ceo_approval') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const summary = inputRecord.resolved.summary || resolveInputText(node, graph, context);
    const config = node.data?.taskConfig || {};
    const standupId = runRow.standup_id || ensureWorkflowStandup();
    const title = config.title || `${def.name} · CEO Approval`;
    let description = buildAgentWorkflowDescription({
      runId,
      definitionId: def.id,
      definitionName: def.name,
      nodeId: node.id,
      nodeLabel: node.data?.label || 'CEO Approval',
      nodeType: 'ceo_approval',
      ownerUserId: runRow.owner_user_id,
      summary,
    });
    if (config.instructions) {
      description = description.replace('## Summary', `## Instructions\n${config.instructions}\n\n## Summary`);
    }
    const kanbanId = createCeoApprovalKanbanTask({
      title,
      description,
      ownerUserId: runRow.owner_user_id,
      standupId,
    });
    upsertStep(runId, node, 'in_progress', {
      input: inputRecord,
      kanban_task_id: kanbanId,
    });
    updateRunProgress(runId);
    return;
  }

  if (node.type === 'agent') {
    const agentId = node.data?.agentId || node.data?.agent_id;
    if (!agentId) {
      upsertStep(runId, node, 'failed', { error_message: 'No agent selected' });
      failRun(runId, `Node ${node.id}: no agent`);
      return;
    }
    const agent = db().prepare('SELECT id, name FROM agents WHERE id = ?').get(agentId);
    if (!agent) {
      upsertStep(runId, node, 'failed', { error_message: 'Agent not found' });
      failRun(runId, `Agent not found: ${agentId}`);
      return;
    }

    const inputRecord = buildStepInputRecord(node, graph, context);
    const inputText = resolveInputText(node, graph, context);
    const prompt = buildAgentPrompt(runId, def.id, def.name, node, inputText, runRow.owner_user_id);
    const requestId = `agent-wf-${runId}-${nodeId}-${Date.now()}`;
    const standupId = runRow.standup_id || ensureWorkflowStandup();

    db()
      .prepare(
        `INSERT INTO agent_delegation_tasks (standup_id, request_id, to_agent_id, prompt, status) VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(standupId, requestId, agentId, prompt);

    const delegationId = db().prepare('SELECT id FROM agent_delegation_tasks ORDER BY id DESC LIMIT 1').get()?.id;
    const kanbanId = createAgentWorkflowKanbanTask({
      title: `${def.name} · ${node.data?.label || agent.name}`,
      description: buildAgentWorkflowDescription({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: node.data?.label,
        nodeType: 'agent',
        ownerUserId: runRow.owner_user_id,
      }),
      agentId,
      standupId,
      delegationTaskId: delegationId,
    });

    upsertStep(runId, node, 'in_progress', {
      input: inputRecord,
      delegation_task_id: delegationId,
      kanban_task_id: kanbanId,
    });
    updateRunProgress(runId);
    return;
  }

  if (node.type === 'tool') {
    const toolName = node.data?.toolName || node.data?.tool_name;
    if (!toolName) {
      upsertStep(runId, node, 'failed', { error_message: 'No tool selected' });
      failRun(runId, `Node ${node.id}: no tool`);
      return;
    }
    const inputRecord = buildStepInputRecord(node, graph, context);
    let payload = { ...(node.data?.toolPayload || node.data?.tool_payload || {}), ...inputRecord.resolved };
    if (payload.message == null && inputRecord.resolved.payload) payload.message = inputRecord.resolved.payload;
    if (payload.input == null && inputRecord.resolved.body) payload.input = inputRecord.resolved.body;

    upsertStep(runId, node, 'in_progress', { input: inputRecord });
    try {
      const result = await invokeContentTool(toolName, payload);
      const outputs = { result, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
      upsertCompletedStepKanban({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: node.data?.label || toolName,
        nodeType: 'tool',
        agentId: null,
        ownerUserId: runRow.owner_user_id,
        summary: `Tool ${toolName} completed`,
        detail: { tool: toolName, inputs: inputRecord.summary },
      });
      updateRunProgress(runId);
      await advanceFromNode(runId, nodeId);
    } catch (err) {
      upsertStep(runId, node, 'failed', { error_message: err.message });
      failRun(runId, err.message);
    }
    return;
  }

  if (node.type === 'mcp_tool') {
    const config = node.data?.taskConfig || node.data?.config || {};
    const mcpServerId = config.mcpServerId || config.mcp_server_id;
    const invokeKind = (config.mcpInvokeKind || config.mcp_invoke_kind || 'tool').toLowerCase();
    const toolName = config.toolName || config.tool_name;
    const promptName = config.promptName || config.prompt_name;
    const resourceUri = config.resourceUri || config.resource_uri;
    if (!mcpServerId) {
      upsertStep(runId, node, 'failed', { error_message: 'MCP server required' });
      failRun(runId, `Node ${node.id}: MCP server not configured`);
      return;
    }
    if (invokeKind === 'tool' && !toolName) {
      upsertStep(runId, node, 'failed', { error_message: 'MCP tool name required' });
      failRun(runId, `Node ${node.id}: MCP tool not configured`);
      return;
    }
    if (invokeKind === 'prompt' && !promptName) {
      upsertStep(runId, node, 'failed', { error_message: 'MCP prompt name required' });
      failRun(runId, `Node ${node.id}: MCP prompt not configured`);
      return;
    }
    if (invokeKind === 'resource' && !resourceUri) {
      upsertStep(runId, node, 'failed', { error_message: 'MCP resource URI required' });
      failRun(runId, `Node ${node.id}: MCP resource not configured`);
      return;
    }
    const ownerAuth = db()
      .prepare('SELECT id, role FROM platform_users WHERE id = ?')
      .get(runRow.owner_user_id) || { id: runRow.owner_user_id, role: 'ceo' };
    const server = getMcpServerForWorkflow(mcpServerId, ownerAuth);
    if (!server) {
      upsertStep(runId, node, 'failed', { error_message: 'MCP server not found or not healthy for this user' });
      failRun(runId, `MCP server unavailable: ${mcpServerId}`);
      return;
    }
    const inputRecord = buildStepInputRecord(node, graph, context);
    let staticArgs = {};
    try {
      staticArgs = JSON.parse(config.staticArguments || config.static_arguments || '{}');
    } catch (_) {
      staticArgs = {};
    }
    let dynamicArgs = {};
    const argRaw = inputRecord.resolved?.arguments || inputRecord.resolved?.payload || inputRecord.resolved?.body;
    if (argRaw) {
      try {
        dynamicArgs = typeof argRaw === 'string' ? JSON.parse(argRaw) : argRaw;
      } catch {
        dynamicArgs = { input: argRaw };
      }
    }
    const mergedArgs = { ...staticArgs, ...dynamicArgs };

    await completeTimedNodeStep({
      runId,
      node,
      nodeId,
      def,
      runRow,
      context,
      inputRecord,
      work: async () => {
        const nodeAuth = parseMcpAuthFromNodeConfig(config);
        let out;
        let stepLabel;
        if (invokeKind === 'prompt') {
          out = await callMcpServerPrompt(mcpServerId, promptName, mergedArgs, ownerAuth, nodeAuth);
          stepLabel = `MCP prompt ${promptName}`;
        } else if (invokeKind === 'resource') {
          const uriFromInput = inputRecord.resolved?.uri || inputRecord.resolved?.resource_uri;
          const uri = String(uriFromInput || resourceUri || '').trim();
          if (!uri) throw new Error('Resource URI required');
          out = await callMcpServerResource(mcpServerId, uri, ownerAuth, nodeAuth);
          stepLabel = `MCP resource ${uri}`;
        } else {
          out = await callMcpServerTool(mcpServerId, toolName, mergedArgs, ownerAuth, nodeAuth);
          stepLabel = `MCP ${toolName}`;
        }
        if (out.is_error) {
          throw new Error(out.text || `${stepLabel} returned an error`);
        }
        return {
          text: out.text || '',
          result: out.result,
          ok: !out.is_error,
          latency_ms: out.latency_ms,
          invoke_kind: invokeKind,
          _stepLabel: stepLabel,
        };
      },
      kanban: (outputs) => ({
        nodeLabel: node.data?.label || outputs._stepLabel || 'MCP',
        summary: `${outputs._stepLabel || 'MCP'} completed`,
        detail: { mcp_server_id: mcpServerId, invoke_kind: invokeKind, ok: outputs.ok, timed_out: !!outputs.timed_out },
      }),
    });
    return;
  }

  if (node.type === 'sse_listen' || node.type === 'mcp_listen') {
    const config = node.data?.taskConfig || node.data?.config || {};
    const ownerAuth = db()
      .prepare('SELECT id, role FROM platform_users WHERE id = ?')
      .get(runRow.owner_user_id) || { id: runRow.owner_user_id, role: 'ceo' };
    let server = null;
    const mcpServerId = config.mcpServerId || config.mcp_server_id;
    if (mcpServerId) {
      server = getMcpServerForWorkflow(mcpServerId, ownerAuth);
      if (!server) {
        upsertStep(runId, node, 'failed', { error_message: 'MCP server not found or not healthy' });
        failRun(runId, `MCP server unavailable: ${mcpServerId}`);
        return;
      }
    }
    let streamUrl;
    try {
      streamUrl = resolveSseStreamUrl(config, server);
    } catch (err) {
      upsertStep(runId, node, 'failed', { error_message: err.message });
      failRun(runId, err.message);
      return;
    }
    const nodeAuth = parseMcpAuthFromNodeConfig(config);

    upsertStep(runId, node, 'listening', {
      input: { stream_url: streamUrl, mcp_server_id: mcpServerId || null },
    });
    registerPendingListener({ runId, nodeId: node.id, streamUrl, mcpServerId, eventsPath: config.eventsPath });

    startPersistentListen({
      runId,
      nodeId: node.id,
      streamUrl,
      authSource: nodeAuth,
      onEvent: (event) => {
        handleListenStreamEvent(runId, node.id, event).catch((err) => {
          console.error('[agent-workflow] SSE event dispatch failed:', err.message);
        });
      },
      onEnd: (meta) => {
        finalizeListenNode(runId, node.id, meta?.aborted ? 'stopped' : 'disconnected').catch((err) => {
          console.error('[agent-workflow] SSE listen finalize failed:', err.message);
        });
      },
      onError: (err) => {
        upsertStep(runId, node, 'failed', { error_message: err.message });
        failRun(runId, err.message);
        clearPendingListener(runId, node.id);
      },
    });
    return;
  }

  if (node.type === 'sub_workflow') {
    const config = node.data?.taskConfig || node.data?.config || {};
    const inputRecord = buildStepInputRecord(node, graph, context);
    upsertStep(runId, node, 'in_progress', { input: inputRecord });
    try {
      const outputs = await executeSubWorkflowTask(config, context, runRow.owner_user_id, context.actor);
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
      upsertCompletedStepKanban({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: node.data?.label || 'Sub-workflow',
        nodeType: 'sub_workflow',
        agentId: null,
        ownerUserId: runRow.owner_user_id,
        summary: outputs.text || `Invoked ${outputs.definition_id}`,
        detail: { outputs },
      });
      updateRunProgress(runId);
      if (!context._event_dispatch) await advanceFromNode(runId, nodeId);
    } catch (err) {
      upsertStep(runId, node, 'failed', { error_message: err.message });
      failRun(runId, err.message);
    }
    return;
  }

  if (node.type === 'email') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    await completeTimedNodeStep({
      runId,
      node,
      nodeId,
      def,
      runRow,
      context,
      inputRecord,
      work: () => executeEmailTask(inputRecord.resolved, config),
      kanban: (outputs) => ({
        nodeLabel: node.data?.label || 'Send Email',
        summary: outputs.sent
          ? `Email sent to ${outputs.to}`
          : `Email attempted: ${outputs.error || 'not sent'}`,
        detail: { inputs: inputRecord.summary, outputs },
      }),
    });
    return;
  }

  if (node.type === 'api') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    const { timeoutMs } = resolveNodeTimeoutConfig(config);
    await completeTimedNodeStep({
      runId,
      node,
      nodeId,
      def,
      runRow,
      context,
      inputRecord,
      work: () => executeApiTask(inputRecord.resolved, { ...config, timeoutMs }, context),
      kanban: (outputs) => ({
        nodeLabel: node.data?.label || 'Call API',
        summary: outputs.timed_out
          ? `API timed out (${Math.round(timeoutMs / 1000)}s)`
          : `API ${outputs.status} ${outputs.ok ? 'ok' : 'failed'}`,
        detail: { inputs: inputRecord.summary, outputs },
      }),
    });
    return;
  }

  if (node.type === 'externalAgent') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    upsertStep(runId, node, 'in_progress', { input: inputRecord });
    try {
      const outputs = await executeExternalAgentTask(
        inputRecord.resolved,
        config,
        context,
        runRow.owner_user_id
      );
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
      upsertCompletedStepKanban({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: node.data?.label || 'External Agent',
        nodeType: 'externalAgent',
        agentId: null,
        ownerUserId: runRow.owner_user_id,
        summary: outputs.ok
          ? `A2A ${outputs.agent_name || config.externalAgentId}: ${(outputs.text || '').slice(0, 80)}`
          : `A2A failed (${outputs.task_state || 'error'})`,
        detail: { inputs: inputRecord.summary, outputs },
      });
      updateRunProgress(runId);
      await advanceFromNode(runId, nodeId);
    } catch (err) {
      upsertStep(runId, node, 'failed', { error_message: err.message });
      failRun(runId, err.message);
    }
    return;
  }

  if (node.type === 'custom_script') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    const { timeoutMs } = resolveNodeTimeoutConfig(config);
    await completeTimedNodeStep({
      runId,
      node,
      nodeId,
      def,
      runRow,
      context,
      inputRecord,
      work: () =>
        executeCustomScriptTask(
          inputRecord.resolved,
          { ...config, timeoutMs },
          { ...context, run_id: runId, definition_id: def.id },
          runRow.owner_user_id
        ),
      kanban: (outputs) => ({
        nodeLabel: node.data?.label || 'Custom Script',
        summary: `Script ${config.customScriptName || config.customScriptId}: ${(outputs.text || '').slice(0, 80)}`,
        detail: { inputs: inputRecord.summary, outputs },
      }),
    });
    return;
  }

  upsertStep(runId, node, 'skipped');
  await advanceFromNode(runId, nodeId);
  } finally {
    activeStepMeta = prevStepMeta;
  }
}

/**
 * Called when an agent workflow delegation completes (from delegation-queue).
 */
export async function maybeAdvanceAgentWorkflow(delegationTask) {
  if (!delegationTask?.prompt || !isAgentWorkflowPrompt(delegationTask.prompt)) return null;

  const meta = parseAgentWorkflowMeta(delegationTask.prompt);
  if (!meta.run_id || !meta.node_id) return null;

  const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(meta.run_id);
  if (!runRow || runRow.status !== 'running') return null;

  const graph = getGraphForRun(meta.run_id);
  const node = getNode(graph, meta.node_id);
  if (!node) return null;

  const context = parseContext(runRow);
  const ok = delegationTask.status === 'completed';
  const output = ok ? delegationTask.response_content || '' : null;

  if (ok) {
    const outputs = { text: output, result: output };
    storeNodeOutput(context, meta.node_id, outputs);
    saveContext(meta.run_id, context);
    upsertStep(meta.run_id, node, 'completed', { output: buildStepOutputRecord(outputs) });
    const def = store.getDefinition(runRow.definition_id);
    upsertCompletedStepKanban({
      runId: meta.run_id,
      definitionId: runRow.definition_id,
      definitionName: def?.name,
      nodeId: meta.node_id,
      nodeLabel: node.data?.label,
      nodeType: 'agent',
      agentId: delegationTask.to_agent_id,
      ownerUserId: runRow.owner_user_id,
      summary: (output || '').slice(0, 200),
    });
    updateRunProgress(meta.run_id);
    await advanceFromNode(meta.run_id, meta.node_id);
    processPendingDelegationTasks().catch(() => {});
    return { advanced: true, run_id: meta.run_id, node_id: meta.node_id };
  }

  upsertStep(meta.run_id, node, 'failed', { error_message: delegationTask.error_message || 'Agent failed' });
  failRun(meta.run_id, delegationTask.error_message || 'Agent step failed');
  return { failed: true, run_id: meta.run_id };
}

export async function failAgentWorkflowForDelegation(failedTask) {
  if (!isAgentWorkflowPrompt(failedTask?.prompt)) return null;
  return maybeAdvanceAgentWorkflow({ ...failedTask, status: 'failed' });
}

/**
 * CEO responds to workflow approval Kanban task (approve / reject + comment).
 */
export async function completeCeoApprovalResponse({ kanbanTaskId, decision, comment = '', actor = null }) {
  const task = db().prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(kanbanTaskId);
  if (!task) throw new Error('Kanban task not found');
  if (!isWorkflowCeoApprovalDescription(task.description)) {
    throw new Error('Not a workflow CEO approval task');
  }
  if (task.status !== 'awaiting_confirmation') throw new Error('Task already resolved');

  const meta = parseAgentWorkflowMeta(task.description);
  if (!meta.run_id || !meta.node_id) throw new Error('Invalid workflow approval task metadata');

  const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(meta.run_id);
  if (!runRow || runRow.status !== 'running') throw new Error('Workflow run is not active');

  const approved = decision === 'approve' || decision === 'approved';
  const decisionLabel = approved ? 'approved' : 'rejected';
  const outputs = {
    decision: decisionLabel,
    approved: approved,
    comment: String(comment || '').trim(),
    text: `${decisionLabel}${comment ? `: ${comment}` : ''}`,
  };

  if (comment?.trim()) {
    db()
      .prepare(`INSERT INTO task_messages (task_id, role, content) VALUES (?, 'user', ?)`)
      .run(kanbanTaskId, `[CEO ${decisionLabel}] ${comment.trim()}`);
  }

  db()
    .prepare(`UPDATE kanban_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(approved ? 'completed' : 'failed', kanbanTaskId);

  const graph = getGraphForRun(meta.run_id);
  const node = getNode(graph, meta.node_id);
  const context = parseContext(runRow);
  storeNodeOutput(context, meta.node_id, outputs);
  saveContext(meta.run_id, context);

  upsertStep(meta.run_id, node, 'completed', {
    output: buildStepOutputRecord(outputs),
    error_message: approved ? null : comment || 'Rejected by CEO',
  });

  const def = store.getDefinition(runRow.definition_id);
  store.appendAudit(runRow.definition_id, {
    action: approved ? 'ceo_approved' : 'ceo_rejected',
    summary: `Run #${runRow.run_number} CEO ${decisionLabel}${comment ? `: ${comment.slice(0, 80)}` : ''}`,
    changedBy: actor?.id,
    changedByName: actor?.name,
  });

  updateRunProgress(meta.run_id);
  await advanceFromNode(meta.run_id, meta.node_id);
  return { decision: decisionLabel, run_id: meta.run_id, advanced: true, outputs };
}

/**
 * Handle each SSE event on a persistent listen node — update outputs and dispatch downstream branch.
 */
export async function handleListenStreamEvent(runId, listenNodeId, event) {
  const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
  if (!runRow || runRow.status !== 'running') return null;

  const def = store.getDefinition(runRow.definition_id, runRow.owner_user_id);
  const graph = def?.published_graph || { nodes: [], edges: [] };
  const node = getNode(graph, listenNodeId);
  if (!node || (node.type !== 'sse_listen' && node.type !== 'mcp_listen')) return null;

  const context = parseContext(runRow);
  context.listen_events = context.listen_events || {};
  const prev = context.listen_events[listenNodeId] || [];
  prev.push({ event, at: new Date().toISOString() });
  context.listen_events[listenNodeId] = prev.slice(-50);
  context.event = event;

  const outputs = {
    event,
    text: JSON.stringify(event),
    event_count: prev.length,
    last_event_at: new Date().toISOString(),
  };
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    for (const [k, v] of Object.entries(event)) {
      if (typeof v !== 'object' || v === null) outputs[k] = v;
    }
  }
  storeNodeOutput(context, listenNodeId, outputs);
  saveContext(runId, context);

  upsertStep(runId, node, 'listening', { output: buildStepOutputRecord(outputs) });

  const downstream = getOutgoingEdges(graph, listenNodeId);
  if (downstream.length) {
    await dispatchListenEventBranch(runId, listenNodeId, event, context, def, runRow);
  }
  return { run_id: runId, event_count: prev.length };
}

async function dispatchListenEventBranch(runId, listenNodeId, event, context, def, runRow) {
  const graph = def?.published_graph || { nodes: [], edges: [] };
  context._event_dispatch = { listenNodeId, dispatchId: Date.now(), event };
  context.event = event;
  saveContext(runId, context);

  for (const nodeId of getDownstreamNodeIds(graph, listenNodeId)) {
    db().prepare(`DELETE FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?`).run(runId, nodeId);
  }

  const freshRun = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
  const freshContext = parseContext(freshRun);
  freshContext._event_dispatch = context._event_dispatch;
  freshContext.event = event;
  freshContext.node_outputs = { ...freshContext.node_outputs, ...context.node_outputs };

  for (const edge of getOutgoingEdges(graph, listenNodeId)) {
    await executeNode(runId, edge.target, graph, freshContext, def, freshRun);
  }

  delete freshContext._event_dispatch;
  saveContext(runId, freshContext);
}

async function finalizeListenNode(runId, listenNodeId, reason = 'disconnected') {
  const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
  if (!runRow) return null;

  const def = store.getDefinition(runRow.definition_id, runRow.owner_user_id);
  const graph = def?.published_graph || { nodes: [], edges: [] };
  const node = getNode(graph, listenNodeId);
  if (!node) return null;

  clearPendingListener(runId, listenNodeId);
  const context = parseContext(runRow);
  const count = context.listen_events?.[listenNodeId]?.length || 0;
  upsertStep(runId, node, 'completed', {
    output: buildStepOutputRecord({
      text: reason === 'stopped' ? 'Listen stopped by user' : 'SSE stream ended',
      event_count: count,
      reason,
    }),
  });
  updateRunProgress(runId);

  const anyPending = db()
    .prepare(`SELECT 1 FROM agent_workflow_run_steps WHERE run_id = ? AND status IN ('pending','in_progress','listening') LIMIT 1`)
    .get(runId);
  if (!anyPending) completeRun(runId);

  const downstream = getOutgoingEdges(graph, listenNodeId);
  if (downstream.length && reason !== 'stopped') {
    await advanceFromNode(runId, listenNodeId);
  }
  return { run_id: runId, reason };
}

/** Stop a persistent SSE listen for a workflow run instance. */
export async function stopSseListen(runId, listenNodeId, ownerUserId, { actor = null } = {}) {
  const run = store.getRun(runId, ownerUserId);
  if (!run) throw new Error('Run not found');
  if (run.status !== 'running') throw new Error('Run is not active');

  const step = run.steps?.find((s) => s.node_id === listenNodeId);
  if (!step || step.status !== 'listening') throw new Error('No active listen step for this node');

  stopPersistentListen(runId, listenNodeId);
  return finalizeListenNode(runId, listenNodeId, 'stopped');
}

/**
 * Try to start workflow from chat message (non-blocking).
 */
export async function tryTriggerWorkflowFromChat(ownerUserId, message, actor) {
  const def = store.findPublishedByChatPhrase(ownerUserId, message);
  if (!def) return null;
  if (!def.trigger_modes.includes('chat')) return null;
  if (!store.isWorkflowTriggerable(def)) return null;
  return startAgentWorkflowRun(def.id, ownerUserId, { trigger: 'chat', input: message, actor });
}

/** Test helper: inject agent step output and continue workflow. */
export async function injectWorkflowStepOutput(runId, nodeId, outputText) {
  const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
  if (!runRow || runRow.status !== 'running') throw new Error('Run not active');

  const graph = getGraphForRun(runId);
  const node = getNode(graph, nodeId);
  if (!node) throw new Error('Node not found');

  const context = parseContext(runRow);
  const outputs = { text: outputText, result: outputText };
  storeNodeOutput(context, nodeId, outputs);
  saveContext(runId, context);
  upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
  await advanceFromNode(runId, nodeId);
  processPendingDelegationTasks().catch(() => {});
  return store.getRun(runId, runRow.owner_user_id);
}

/**
 * Apply persisted timeout for an in_progress step using original started_at + node config.
 * Used after restart and by the periodic watchdog (in-memory timers are gone on restart).
 */
async function applyPersistedNodeTimeout(runId, node, def, runRow, context, timeoutMs, timeoutAction, defaultOutput) {
  const secs = Math.max(1, Math.round(Number(timeoutMs) / 1000));
  const errMessage = `Node timed out after ${secs}s (limit ${timeoutMs}ms)`;

  if (timeoutAction === 'default_output') {
    const outputs = buildTimeoutFallbackOutputs(node.type, defaultOutput, timeoutMs);
    storeNodeOutput(context, node.id, outputs);
    saveContext(runId, context);
    upsertStep(runId, node, 'completed', {
      output: buildStepOutputRecord(outputs),
      error_message: errMessage,
    });
    updateRunProgress(runId);
    console.log(
      `[agent-workflow] run ${runId} node ${node.id} timed out — continued with default_output`
    );
    await advanceFromNode(runId, node.id);
    return;
  }

  upsertStep(runId, node, 'failed', { error_message: errMessage });
  failRun(runId, errMessage);
  console.log(`[agent-workflow] run ${runId} node ${node.id} timed out — run failed`);
}

/**
 * Fail or continue any in_progress step whose wall-clock age exceeds its configured timeout.
 * @returns {number} number of steps reaped
 */
export async function reapTimedOutWorkflowSteps() {
  const rows = db()
    .prepare(
      `SELECT s.run_id, s.node_id, s.node_type, s.started_at, s.iteration
       FROM agent_workflow_run_steps s
       JOIN agent_workflow_runs r ON r.id = s.run_id
       WHERE r.status = 'running' AND s.status = 'in_progress'
       ORDER BY s.id ASC`
    )
    .all();

  let reaped = 0;
  for (const step of rows) {
    const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(step.run_id);
    if (!runRow || runRow.status !== 'running') continue;

    const def = store.getDefinition(runRow.definition_id);
    const graph = def?.published_graph || { nodes: [], edges: [] };
    const node = getNode(graph, step.node_id);
    if (!node) continue;
    if (LISTEN_TYPES.has(node.type) || EXTERNAL_WAIT_TYPES.has(node.type)) continue;

    const config = node.data?.taskConfig || node.data?.config || {};
    const { timeoutMs, timeoutAction, defaultOutput } = resolveNodeTimeoutConfig(config);
    if (!isPersistedStepTimedOut(step, timeoutMs)) continue;

    const context = parseContext(runRow);
    activeStepMeta = { graph, context };
    try {
      await applyPersistedNodeTimeout(
        step.run_id,
        node,
        def,
        runRow,
        context,
        timeoutMs,
        timeoutAction,
        defaultOutput
      );
      reaped += 1;
    } catch (err) {
      console.error(
        `[agent-workflow] reap timeout run ${step.run_id} node ${step.node_id} failed:`,
        err?.message || err
      );
      failRun(step.run_id, err?.message || 'Workflow timeout reap failed');
    } finally {
      activeStepMeta = null;
    }
  }
  return reaped;
}

/**
 * Resume runs left orphaned when the server restarted mid-execution.
 * Continues from last persisted state; re-arms node timeouts from original started_at.
 */
export function resumeStuckWorkflowRuns() {
  void (async () => {
    try {
      await reapTimedOutWorkflowSteps();
    } catch (err) {
      console.warn('[agent-workflow] startup timeout reap:', err?.message || err);
    }

    const rows = db()
      .prepare(`SELECT id FROM agent_workflow_runs WHERE status = 'running' ORDER BY id ASC`)
      .all();

    for (const { id: runId } of rows) {
      const runRow = db().prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
      if (!runRow || runRow.status !== 'running') continue;

      const def = store.getDefinition(runRow.definition_id);
      const graph = def?.published_graph || { nodes: [], edges: [] };
      const context = parseContext(runRow);
      const steps = db()
        .prepare(
          `SELECT id, node_id, node_type, status, started_at, iteration
           FROM agent_workflow_run_steps WHERE run_id = ? ORDER BY id ASC`
        )
        .all(runId);
      if (!steps.length) continue;

      const latestByNode = new Map();
      for (const s of steps) latestByNode.set(s.node_id, s);

      let resumedWork = false;
      const scheduledNodeIds = new Set();

      for (const step of latestByNode.values()) {
        if (step.status !== 'in_progress') continue;
        const node = getNode(graph, step.node_id);
        if (!node) continue;
        if (LISTEN_TYPES.has(node.type) || EXTERNAL_WAIT_TYPES.has(node.type)) continue;

        const config = node.data?.taskConfig || node.data?.config || {};
        const { timeoutMs } = resolveNodeTimeoutConfig(config);

        if (isPersistedStepTimedOut(step, timeoutMs)) {
          // Already handled by reap; skip if still somehow present
          continue;
        }

        // Only re-dispatch steps that began before this process (avoid racing with reap→advance).
        if (!isRestartOrphanStep(step)) continue;

        if (!RESUMABLE_IN_PROGRESS_TYPES.has(node.type)) {
          console.warn(
            `[agent-workflow] run ${runId} node ${node.id} (${node.type}) left in_progress after restart — not auto-resumable`
          );
          continue;
        }

        const remaining = remainingTimeoutMsForStep(step, timeoutMs);
        resumeTimeoutOverrides.set(`${runId}:${node.id}`, { remainingTimeoutMs: remaining });
        // Reset to pending so executeNode will re-dispatch; started_at is preserved (COALESCE).
        activeStepMeta = { graph, context };
        upsertStep(runId, node, 'pending', {});
        activeStepMeta = null;
        scheduledNodeIds.add(node.id);
        console.log(
          `[agent-workflow] resuming run ${runId} node ${node.id} (${node.type}) with ${Math.round(remaining / 1000)}s remaining timeout`
        );
        resumedWork = true;
        void executeNode(runId, node.id, graph, context, def, runRow)
          .catch((err) => {
            console.error(`[agent-workflow] resume run ${runId} node ${node.id} failed:`, err);
            failRun(runId, err?.message || 'Workflow resume failed');
          })
          .finally(() => {
            processPendingDelegationTasks().catch(() => {});
          });
      }

      for (const step of latestByNode.values()) {
        // Only dispatch originally-pending steps here; in_progress→pending already scheduled.
        if (step.status !== 'pending') continue;
        if (scheduledNodeIds.has(step.node_id)) continue;
        const node = getNode(graph, step.node_id);
        if (!node) continue;
        console.log(`[agent-workflow] dispatching pending run ${runId} node ${node.id}`);
        scheduledNodeIds.add(node.id);
        resumedWork = true;
        void executeNode(runId, node.id, graph, context, def, runRow)
          .catch((err) => {
            console.error(`[agent-workflow] resume pending run ${runId} node ${node.id} failed:`, err);
            failRun(runId, err?.message || 'Workflow resume failed');
          })
          .finally(() => {
            processPendingDelegationTasks().catch(() => {});
          });
      }

      if (resumedWork) continue;

      const hasActive = [...latestByNode.values()].some((s) =>
        ['in_progress', 'listening', 'pending'].includes(s.status)
      );
      if (hasActive) continue;

      const lastCompleted = [...steps].reverse().find((s) => s.status === 'completed');
      if (!lastCompleted) continue;
      console.log(`[agent-workflow] resuming stuck run ${runId} from ${lastCompleted.node_id}`);
      void advanceFromNode(runId, lastCompleted.node_id)
        .catch((err) => {
          console.error(`[agent-workflow] resume run ${runId} failed:`, err);
          failRun(runId, err?.message || 'Workflow resume failed');
        })
        .finally(() => {
          processPendingDelegationTasks().catch(() => {});
        });
    }
  })();
}

let timeoutWatchdogTimer = null;

/** Periodic safety net: reap steps whose started_at + timeoutMs elapsed (covers restart + lost timers). */
export function startWorkflowTimeoutWatchdog(intervalMs = 30000) {
  if (timeoutWatchdogTimer) return;
  const ms = Math.max(5000, Number(intervalMs) || 30000);
  timeoutWatchdogTimer = setInterval(() => {
    void reapTimedOutWorkflowSteps().catch((err) => {
      console.warn('[agent-workflow] timeout watchdog:', err?.message || err);
    });
  }, ms);
  if (typeof timeoutWatchdogTimer.unref === 'function') timeoutWatchdogTimer.unref();
  console.log(`[agent-workflow] timeout watchdog every ${ms}ms`);
}

export { isAgentWorkflowPrompt };
