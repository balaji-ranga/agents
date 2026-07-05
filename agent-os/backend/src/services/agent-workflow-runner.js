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
import { executeBrainTask } from './agent-workflow-brain.js';
import { evaluateCondition } from './agent-workflow-conditions.js';
import { getTaskTypeDef } from './agent-workflow-task-catalog.js';

const PORT = Number(process.env.PORT) || 3001;

function db() {
  return getDb();
}

function getBackendBaseUrl() {
  return (process.env.AGENT_OS_BASE_URL || process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
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

function updateRunProgress(runId) {
  const total = db().prepare('SELECT COUNT(*) AS n FROM agent_workflow_run_steps WHERE run_id = ?').get(runId).n;
  const done = db()
    .prepare(`SELECT COUNT(*) AS n FROM agent_workflow_run_steps WHERE run_id = ? AND status IN ('completed','skipped')`)
    .get(runId).n;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
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

function allPredecessorsComplete(runId, graph, nodeId) {
  const incoming = getIncomingEdges(graph, nodeId);
  if (!incoming.length) return true;
  for (const edge of incoming) {
    const step = db()
      .prepare(`SELECT status FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?`)
      .get(runId, edge.source);
    if (!step || !['completed', 'skipped'].includes(step.status)) return false;
  }
  return true;
}

function buildStepInputRecord(node, graph, context) {
  const { resolved, summary } = resolveNodeInputs(node, graph, context);
  const outputSchema = node.data?.outputs || getTaskTypeDef(node.type)?.outputs || [];
  return {
    inputs: summary,
    resolved,
    outputs_schema: outputSchema,
  };
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
  const existing = db()
    .prepare(`SELECT id FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?`)
    .get(runId, node.id);
  const label = node.data?.label || node.id;
  if (existing) {
    db()
      .prepare(
        `UPDATE agent_workflow_run_steps SET status = ?, node_label = ?, input_json = COALESCE(?, input_json),
         output_json = COALESCE(?, output_json), delegation_task_id = COALESCE(?, delegation_task_id),
         kanban_task_id = COALESCE(?, kanban_task_id), started_at = COALESCE(started_at, datetime('now')),
         completed_at = ?, error_message = ?, node_type = ?
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
        existing.id
      );
    return existing.id;
  }
  db()
    .prepare(
      `INSERT INTO agent_workflow_run_steps (run_id, node_id, node_type, node_label, status, input_json, output_json,
       delegation_task_id, kanban_task_id, started_at, completed_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`
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
      extra.error_message ?? null
    );
  return db().prepare('SELECT id FROM agent_workflow_run_steps ORDER BY id DESC LIMIT 1').get()?.id;
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
  if (def.status !== 'published' || !def.published_graph) {
    throw new Error('Workflow must be published before running');
  }

  const graph = def.published_graph;
  const triggerNode = graph.nodes.find((n) => n.type === 'trigger');
  if (!triggerNode) throw new Error('Published workflow has no trigger node');

  const runNumber =
    (db()
      .prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS n FROM agent_workflow_runs WHERE definition_id = ?')
      .get(definitionId)?.n) || 1;

  const standupId = ensureWorkflowStandup();
  const context = { initial_input: input, node_outputs: {}, actor };

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

  await advanceFromNode(runId, triggerNode.id);
  processPendingDelegationTasks().catch(() => {});

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
      .prepare(`SELECT 1 FROM agent_workflow_run_steps WHERE run_id = ? AND status IN ('pending','in_progress') LIMIT 1`)
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

  const existing = db()
    .prepare(`SELECT status FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?`)
    .get(runId, nodeId);
  const allowRerun = node.type === 'while';
  if (existing && ['completed', 'in_progress', 'failed'].includes(existing.status) && !allowRerun) return;
  if (existing && existing.status === 'in_progress' && node.type !== 'ceo_approval') return;

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
      });
      updateRunProgress(runId);
      await advanceFromNode(runId, nodeId, 'exit');
    }
    return;
  }

  if (node.type === 'brain') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    if (typeof config.mcpEndpoints === 'string') {
      try {
        config.mcpEndpoints = JSON.parse(config.mcpEndpoints);
      } catch {
        config.mcpEndpoints = [];
      }
    }
    upsertStep(runId, node, 'in_progress', { input: inputRecord });
    try {
      const outputs = await executeBrainTask(config, inputRecord.resolved, context, graph);
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
      upsertCompletedStepKanban({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: node.data?.label || 'Brain',
        nodeType: 'brain',
        agentId: null,
        ownerUserId: runRow.owner_user_id,
        summary: (outputs.text || '').slice(0, 200),
        detail: { model: outputs.model_used, provider: outputs.provider },
      });
      updateRunProgress(runId);
      await advanceFromNode(runId, nodeId);
    } catch (err) {
      upsertStep(runId, node, 'failed', { error_message: err.message });
      failRun(runId, err.message);
    }
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

  if (node.type === 'email') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    upsertStep(runId, node, 'in_progress', { input: inputRecord });
    try {
      const outputs = await executeEmailTask(inputRecord.resolved, config);
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
      upsertCompletedStepKanban({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: node.data?.label || 'Send Email',
        nodeType: 'email',
        agentId: null,
        ownerUserId: runRow.owner_user_id,
        summary: outputs.sent ? `Email sent to ${outputs.to}` : `Email attempted: ${outputs.error || 'not sent'}`,
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

  if (node.type === 'api') {
    const inputRecord = buildStepInputRecord(node, graph, context);
    const config = node.data?.taskConfig || node.data?.config || {};
    upsertStep(runId, node, 'in_progress', { input: inputRecord });
    try {
      const outputs = await executeApiTask(inputRecord.resolved, config);
      storeNodeOutput(context, node.id, outputs);
      saveContext(runId, context);
      upsertStep(runId, node, 'completed', { output: buildStepOutputRecord(outputs) });
      upsertCompletedStepKanban({
        runId,
        definitionId: def.id,
        definitionName: def.name,
        nodeId: node.id,
        nodeLabel: node.data?.label || 'Call API',
        nodeType: 'api',
        agentId: null,
        ownerUserId: runRow.owner_user_id,
        summary: `API ${outputs.status} ${outputs.ok ? 'ok' : 'failed'}`,
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

  upsertStep(runId, node, 'skipped');
  await advanceFromNode(runId, nodeId);
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

export { isAgentWorkflowPrompt };
