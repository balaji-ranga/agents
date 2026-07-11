/**
 * Programmatic workflow graph mutations for the Workflow Builder agent.
 */
import * as store from './agent-workflow-store.js';
import {
  defaultInputBindings,
  defaultNodeConfig,
  defaultOutputsList,
  getTaskCatalog,
  getTaskTypeDef,
} from './agent-workflow-task-catalog.js';
import { triggerAgentWorkflowForOwner, resolveWorkflowForTrigger, resolveRunForOwner, summarizeRunForAgent, waitForRunTerminal } from './agent-workflow-chat-tools.js';
import {
  pauseRun,
  deleteRun,
  pauseAllRuns,
  deleteDefinitionWithCleanup,
} from './agent-workflow-run-manager.js';
import { stopSseListen } from './agent-workflow-runner.js';
import { stopScheduleForDefinition, refreshAgentWorkflowSchedules } from './agent-workflow-scheduler.js';
import { getWorkflowTemplate } from './agent-workflow-templates.js';
import { buildDetailedGraphSummary } from './agent-workflow-agent-describe.js';
import {
  normalizeBrainTaskConfig,
  buildWorkflowNodeCatalog,
  getWorkflowNodeTypeSpec,
  validateWorkflowForPublish,
} from './agent-workflow-builder-catalog.js';
import { defaultBrainConfig } from './agent-workflow-agent-runtime-context.js';

function ensureDraftForEdit(def, currentId, ownerUserId, actor) {
  if (!def || def.status !== 'published') return def;
  const updated = store.unpublishDefinition(currentId, ownerUserId, actor);
  stopScheduleForDefinition(currentId);
  refreshAgentWorkflowSchedules();
  return updated;
}

const GRAPH_MUTATION_OPS = new Set([
  'add_node', 'update_node', 'delete_node', 'add_edge', 'connect', 'delete_edge', 'set_metadata', 'update_metadata',
]);

const VALID_TYPES = new Set(getTaskCatalog().map((t) => t.type));

function cloneGraph(graph) {
  return JSON.parse(JSON.stringify(graph || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }));
}

function nextNodeId(graph, type) {
  const prefix = type.replace(/[^a-z0-9]/gi, '') || 'step';
  let n = 1;
  while (graph.nodes.some((node) => node.id === `${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

function nextEdgeId(graph) {
  let n = graph.edges.length + 1;
  while (graph.edges.some((e) => e.id === `e${n}`)) n += 1;
  return `e${n}`;
}

export function buildDefaultNode(type, { nodeId, label, position, data = {} } = {}) {
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown node type: ${type}`);
  const def = getTaskTypeDef(type);
  const id = nodeId || nextNodeId({ nodes: [], edges: [] }, type);
  const pos = position || { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 };
  const nodeData = {
    label: label || def?.label || type,
    inputBindings: defaultInputBindings(type),
    outputs: defaultOutputsList(type),
    taskConfig: defaultNodeConfig(type),
    ...data,
  };

  if (type === 'trigger') {
    nodeData.triggerModes = data.triggerModes || ['manual', 'chat'];
    nodeData.scheduleCron = data.scheduleCron || '';
    nodeData.chatPhrase = data.chatPhrase || '';
    delete nodeData.inputBindings;
  }
  if (type === 'agent') {
    nodeData.agentId = data.agentId || '';
    nodeData.agentName = data.agentName || '';
    nodeData.prompt = data.prompt || 'Complete this task:\n\n{{input}}';
  }
  if (type === 'tool') {
    nodeData.toolName = data.toolName || '';
    nodeData.toolPayload = data.toolPayload || {};
  }
  if (type === 'brain') {
    nodeData.taskConfig = normalizeBrainTaskConfig(nodeData.taskConfig, defaultBrainConfig());
  }

  return { id, type, position: pos, data: nodeData };
}

export function summarizeGraphForAgent(graph) {
  return buildDetailedGraphSummary(graph);
}

/**
 * Apply one or more builder actions. Returns { workflow, graph, results, workflow_id }.
 */
export async function applyWorkflowBuilderActions(ownerUserId, workflowId, actions, actor) {
  if (!Array.isArray(actions) || !actions.length) {
    throw new Error('actions array required');
  }

  let currentId = workflowId || null;
  let def = currentId ? store.getDefinition(currentId, ownerUserId) : null;
  const results = [];

  for (const action of actions) {
    const op = action.action || action.op || action.type;
    if (!op) {
      results.push({ action: '(missing)', ok: false, error: 'Each action needs action/op/type' });
      continue;
    }

    try {
    if (op === 'get_node_catalog') {
      results.push({ action: op, ok: true, catalog: buildWorkflowNodeCatalog() });
      continue;
    }

    if (op === 'get_node_type') {
      const nodeType = action.node_type || action.type;
      const spec = getWorkflowNodeTypeSpec(nodeType);
      results.push({ action: op, ok: !spec.error, spec, error: spec.error || undefined });
      continue;
    }

    if (op === 'validate_publish') {
      if (!currentId || !def) throw new Error('No workflow in context for validate_publish');
      const errors = validateWorkflowForPublish(def.draft_graph);
      results.push({ action: op, ok: errors.length === 0, errors });
      continue;
    }

    if (GRAPH_MUTATION_OPS.has(op) && currentId && def?.status === 'published') {
      def = ensureDraftForEdit(def, currentId, ownerUserId, actor);
    }

    if (op === 'create_workflow') {
      const name = String(action.name || 'New workflow').trim();
      if (!name) throw new Error('create_workflow requires name');
      let graph = action.graph ? cloneGraph(action.graph) : null;
      if (!graph?.nodes?.length) {
        const trigger = buildDefaultNode('trigger', { nodeId: 'trigger-1', label: 'Start', position: { x: 40, y: 120 } });
        graph = { nodes: [trigger], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
      }
      def = store.createDefinition({
        name,
        description: action.description || '',
        ownerUserId,
        actor,
        graph,
        trigger_modes: action.trigger_modes || ['manual'],
        chat_trigger_phrase: action.chat_phrase || action.chat_trigger_phrase || '',
        schedule_cron: action.schedule_cron || '',
      });
      currentId = def.id;
      results.push({ action: op, ok: true, workflow_id: currentId, name: def.name });
      continue;
    }

    if (op === 'create_from_template') {
      const templateId = String(action.template_id || '').trim();
      const tpl = getWorkflowTemplate(templateId);
      if (!tpl?.graph) throw new Error(`Template not found or has no graph: ${templateId}`);
      const name = String(action.name || tpl.name || 'New workflow').trim();
      def = store.createDefinition({
        name,
        description: action.description || tpl.description || '',
        ownerUserId,
        actor,
        graph: cloneGraph(tpl.graph),
        trigger_modes: action.trigger_modes || tpl.default_trigger_modes || ['manual'],
        chat_trigger_phrase: action.chat_phrase || action.chat_trigger_phrase || tpl.default_chat_phrase || '',
        schedule_cron: action.schedule_cron || tpl.default_schedule_cron || '',
      });
      currentId = def.id;
      results.push({ action: op, ok: true, workflow_id: currentId, name: def.name, template_id: templateId });
      continue;
    }

    if (op === 'open_workflow' || op === 'load_workflow' || op === 'reload_workflow') {
      const target = resolveWorkflowForTrigger(ownerUserId, {
        workflow_id: action.workflow_id || currentId,
        workflow_name: action.workflow_name || action.name,
      });
      if (!target) throw new Error('Workflow not found for open/reload');
      currentId = target.id;
      def = store.getDefinition(currentId, ownerUserId);
      results.push({ action: op, ok: true, workflow_id: currentId, name: def.name, status: def.status });
      continue;
    }

    if (
      op === 'unpublish' ||
      op === 'revert_to_draft' ||
      op === 'unpublish_workflow' ||
      (op === 'set_status' && String(action.status || '').toLowerCase() === 'draft')
    ) {
      const target = resolveWorkflowForTrigger(ownerUserId, {
        workflow_id: action.workflow_id || currentId,
        workflow_name: action.workflow_name || action.name,
      });
      if (!target) throw new Error('Workflow not found');
      def = store.unpublishDefinition(target.id, ownerUserId, actor);
      stopScheduleForDefinition(target.id);
      refreshAgentWorkflowSchedules();
      currentId = target.id;
      results.push({ action: op, ok: true, workflow_id: target.id, status: def.status, name: def.name });
      continue;
    }

    if (op === 'pause_workflow') {
      const target = resolveWorkflowForTrigger(ownerUserId, {
        workflow_id: action.workflow_id || currentId,
        workflow_name: action.workflow_name || action.name,
      });
      if (!target) throw new Error('Workflow not found');
      def = store.setPaused(target.id, ownerUserId, true, actor);
      stopScheduleForDefinition(target.id);
      pauseAllRuns(ownerUserId, { definitionId: target.id, actor });
      refreshAgentWorkflowSchedules();
      currentId = target.id;
      results.push({ action: op, ok: true, workflow_id: target.id, paused: true });
      continue;
    }

    if (op === 'resume_workflow') {
      const target = resolveWorkflowForTrigger(ownerUserId, {
        workflow_id: action.workflow_id || currentId,
        workflow_name: action.workflow_name || action.name,
      });
      if (!target) throw new Error('Workflow not found');
      def = store.setPaused(target.id, ownerUserId, false, actor);
      refreshAgentWorkflowSchedules();
      currentId = target.id;
      results.push({ action: op, ok: true, workflow_id: target.id, paused: false });
      continue;
    }

    if (op === 'trigger_workflow' || op === 'trigger_run') {
      const run = await triggerAgentWorkflowForOwner(ownerUserId, {
        message: action.message || action.input || action.chat_phrase || '',
        workflow_id: action.workflow_id || currentId,
        workflow_name: action.workflow_name || action.name || action.workflowName,
        actor,
      });
      results.push({
        action: op,
        ok: true,
        run_id: run.id,
        run_number: run.run_number,
        definition_id: run.definition_id,
      });
      continue;
    }

    if (op === 'pause_run') {
      const run = resolveRunForOwner(ownerUserId, {
        run_id: action.run_id,
        run_number: action.run_number,
        workflow_id: action.workflow_id || action.definition_id || currentId,
      });
      if (!run) throw new Error('Run not found');
      const updated = pauseRun(run.id, ownerUserId, actor);
      results.push({ action: op, ok: true, run_id: run.id, run_number: run.run_number, status: updated?.status });
      continue;
    }

    if (op === 'stop_run' || op === 'cancel_run' || op === 'delete_run') {
      const run = resolveRunForOwner(ownerUserId, {
        run_id: action.run_id,
        run_number: action.run_number,
        workflow_id: action.workflow_id || action.definition_id || currentId,
      });
      if (!run) throw new Error('Run not found');
      deleteRun(run.id, ownerUserId, actor);
      results.push({ action: op, ok: true, run_id: run.id, run_number: run.run_number, deleted: true });
      continue;
    }

    if (op === 'pause_all_runs') {
      const definitionId = action.workflow_id || action.definition_id || currentId || null;
      const out = pauseAllRuns(ownerUserId, { definitionId, actor });
      results.push({ action: op, ok: true, paused: out.paused, definition_id: definitionId });
      continue;
    }

    if (op === 'inspect_run') {
      let targetWorkflowId = action.workflow_id || action.definition_id || currentId;
      if (!targetWorkflowId && (action.workflow_name || action.name)) {
        const target = resolveWorkflowForTrigger(ownerUserId, {
          workflow_name: action.workflow_name || action.name,
        });
        if (target) targetWorkflowId = target.id;
      }
      const run = resolveRunForOwner(ownerUserId, {
        run_id: action.run_id,
        run_number: action.run_number,
        workflow_id: targetWorkflowId,
        workflow_name: action.workflow_name || action.name,
        latest_failed: action.latest_failed,
      });
      if (!run) throw new Error('Run not found');
      results.push({ action: op, ok: true, run: summarizeRunForAgent(run) });
      continue;
    }

    if (op === 'list_runs') {
      const target = resolveWorkflowForTrigger(ownerUserId, {
        workflow_id: action.workflow_id || action.definition_id || currentId,
        workflow_name: action.workflow_name || action.name,
      });
      if (!target) throw new Error('Workflow not found for list_runs');
      const limit = Math.min(Number(action.limit) || 20, 50);
      const runs = store.listRuns(target.id, ownerUserId, limit).map((r) => ({
        run_id: r.id,
        run_number: r.run_number,
        status: r.status,
        progress_pct: r.progress_pct,
        error_message: r.error_message || null,
        started_at: r.started_at,
        completed_at: r.completed_at,
      }));
      currentId = target.id;
      def = store.getDefinition(currentId, ownerUserId);
      results.push({ action: op, ok: true, workflow_id: target.id, runs });
      continue;
    }

    if (op === 'test_workflow') {
      const target = resolveWorkflowForTrigger(ownerUserId, {
        workflow_id: action.workflow_id || currentId,
        workflow_name: action.workflow_name || action.name,
        message: action.message || action.input || '',
      });
      if (!target) throw new Error('Workflow not found for test');
      if (!store.isWorkflowTriggerable(target)) {
        throw new Error(`Workflow "${target.name}" is not runnable — publish and resume first`);
      }
      const run = await triggerAgentWorkflowForOwner(ownerUserId, {
        workflow_id: target.id,
        input: action.input || action.message || `Test run: ${target.name}`,
        actor,
      });
      currentId = target.id;
      def = store.getDefinition(currentId, ownerUserId);
      const wait = action.wait !== false;
      let inspected = null;
      if (wait) {
        const terminal = await waitForRunTerminal(ownerUserId, run.id, Number(action.timeout_ms) || 45000);
        inspected = summarizeRunForAgent(terminal);
      }
      results.push({
        action: op,
        ok: true,
        run_id: run.id,
        run_number: run.run_number,
        definition_id: run.definition_id,
        run: inspected,
      });
      continue;
    }

    if (op === 'stop_listen') {
      const run = resolveRunForOwner(ownerUserId, {
        run_id: action.run_id,
        run_number: action.run_number,
        workflow_id: action.workflow_id || currentId,
      });
      if (!run) throw new Error('Run not found');
      const nodeId = action.node_id || action.nodeId;
      if (!nodeId) throw new Error('stop_listen requires node_id');
      await stopSseListen(run.id, nodeId, ownerUserId, { actor });
      results.push({ action: op, ok: true, run_id: run.id, node_id: nodeId });
      continue;
    }

    if (op === 'delete_workflow') {
      const target = resolveWorkflowForTrigger(ownerUserId, {
        workflow_id: action.workflow_id || currentId,
        workflow_name: action.workflow_name || action.name,
      });
      if (!target) throw new Error('Workflow not found');
      deleteDefinitionWithCleanup(target.id, ownerUserId, actor);
      if (currentId === target.id) {
        currentId = null;
        def = null;
      }
      results.push({ action: op, ok: true, workflow_id: target.id, deleted: true });
      continue;
    }

    if (!currentId || !def) throw new Error('No workflow in context — use create_workflow or open_workflow first');

    const graph = cloneGraph(def.draft_graph);

    if (op === 'add_node') {
      const type = action.node_type || action.type;
      if (!type || type === 'create_workflow') throw new Error('add_node requires node_type');
      const node = buildDefaultNode(type, {
        nodeId: action.node_id || action.id || nextNodeId(graph, type),
        label: action.label,
        position: action.position,
        data: action.data || {},
      });
      if (action.agent_id) {
        node.data.agentId = action.agent_id;
        node.data.agentName = action.agent_name || action.agent_id;
      }
      if (action.prompt) node.data.prompt = action.prompt;
      if (action.system_prompt) node.data.taskConfig = { ...node.data.taskConfig, systemPrompt: action.system_prompt };
      if (action.task_config) {
        node.data.taskConfig = { ...node.data.taskConfig, ...action.task_config };
        if (type === 'brain') {
          node.data.taskConfig = normalizeBrainTaskConfig(node.data.taskConfig, defaultBrainConfig());
        }
      }
      if (action.connect_from) {
        const edge = {
          id: nextEdgeId(graph),
          source: action.connect_from,
          target: node.id,
          sourceHandle: action.source_handle,
        };
        graph.edges.push(edge);
      }
      graph.nodes.push(node);
      def = store.updateDraft(currentId, ownerUserId, { graph }, actor);
      results.push({ action: op, ok: true, node_id: node.id, type: node.type });
      continue;
    }

    if (op === 'update_node') {
      const nodeId = action.node_id || action.id;
      const idx = graph.nodes.findIndex((n) => n.id === nodeId);
      if (idx < 0) throw new Error(`Node not found: ${nodeId}`);
      const node = graph.nodes[idx];
      if (action.label) node.data.label = action.label;
      if (action.data) node.data = { ...node.data, ...action.data };
      if (action.prompt) node.data.prompt = action.prompt;
      if (action.agent_id) {
        node.data.agentId = action.agent_id;
        node.data.agentName = action.agent_name || action.agent_id;
      }
      if (action.input_bindings) node.data.inputBindings = action.input_bindings;
      if (action.task_config) {
        node.data.taskConfig = { ...node.data.taskConfig, ...action.task_config };
        if (node.type === 'brain') {
          node.data.taskConfig = normalizeBrainTaskConfig(node.data.taskConfig, defaultBrainConfig());
        }
      }
      graph.nodes[idx] = node;
      def = store.updateDraft(currentId, ownerUserId, { graph }, actor);
      results.push({ action: op, ok: true, node_id: nodeId });
      continue;
    }

    if (op === 'delete_node') {
      const nodeId = action.node_id || action.id;
      graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
      graph.edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
      def = store.updateDraft(currentId, ownerUserId, { graph }, actor);
      results.push({ action: op, ok: true, node_id: nodeId });
      continue;
    }

    if (op === 'add_edge' || op === 'connect') {
      const source = action.source || action.from;
      const target = action.target || action.to;
      if (!source || !target) throw new Error('add_edge requires source and target');
      const edge = {
        id: action.edge_id || nextEdgeId(graph),
        source,
        target,
        sourceHandle: action.source_handle || action.sourceHandle,
        targetHandle: action.target_handle || action.targetHandle,
      };
      graph.edges.push(edge);
      def = store.updateDraft(currentId, ownerUserId, { graph }, actor);
      results.push({ action: op, ok: true, edge_id: edge.id, source, target });
      continue;
    }

    if (op === 'delete_edge') {
      const edgeId = action.edge_id;
      if (edgeId) {
        graph.edges = graph.edges.filter((e) => e.id !== edgeId);
      } else if (action.source && action.target) {
        graph.edges = graph.edges.filter((e) => !(e.source === action.source && e.target === action.target));
      } else throw new Error('delete_edge requires edge_id or source+target');
      def = store.updateDraft(currentId, ownerUserId, { graph }, actor);
      results.push({ action: op, ok: true });
      continue;
    }

    if (op === 'set_metadata' || op === 'update_metadata') {
      const patch = {};
      if (action.name) patch.name = action.name;
      if (action.description != null) patch.description = action.description;
      if (action.chat_phrase != null || action.chat_trigger_phrase != null) {
        patch.chat_trigger_phrase = action.chat_phrase ?? action.chat_trigger_phrase;
      }
      if (action.trigger_modes) patch.trigger_modes = action.trigger_modes;
      if (action.schedule_cron != null) patch.schedule_cron = action.schedule_cron;
      def = store.updateDraft(currentId, ownerUserId, patch, actor);
      results.push({ action: op, ok: true, ...patch });
      continue;
    }

    if (op === 'publish') {
      def = store.publishDefinition(currentId, ownerUserId, actor);
      refreshAgentWorkflowSchedules();
      results.push({ action: op, ok: true, status: def.status });
      continue;
    }

    throw new Error(`Unknown action: ${op}`);
    } catch (err) {
      results.push({ action: op, ok: false, error: err.message });
    }
  }

  def = currentId ? store.getDefinition(currentId, ownerUserId) : def;
  return {
    workflow_id: currentId,
    workflow: def,
    draft_graph: def?.draft_graph,
    graph_summary: summarizeGraphForAgent(def?.draft_graph),
    results,
    has_errors: results.some((r) => r.ok === false),
  };
}

export function getWorkflowDraftForAgent(ownerUserId, workflowId) {
  const def = store.getDefinition(workflowId, ownerUserId);
  if (!def) throw new Error('Workflow not found');
  return {
    workflow_id: def.id,
    name: def.name,
    description: def.description,
    status: def.status,
    paused: !!def.paused,
    trigger_modes: def.trigger_modes,
    chat_trigger_phrase: def.chat_trigger_phrase,
    schedule_cron: def.schedule_cron,
    graph_summary: summarizeGraphForAgent(def.draft_graph),
    draft_graph: def.draft_graph,
  };
}
