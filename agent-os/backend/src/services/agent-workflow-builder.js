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
import { triggerAgentWorkflowForOwner } from './agent-workflow-chat-tools.js';

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
  if (type === 'brain' && !nodeData.taskConfig?.modelSource) {
    nodeData.taskConfig = {
      modelSource: 'ollama',
      apiEndpoint: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
      model: process.env.OLLAMA_MODEL || 'llama3.2',
      maxTokens: 512,
      systemPrompt: 'You are a concise assistant.\n\nContext:\n{{input}}',
      mcpEndpoints: '[]',
      ...nodeData.taskConfig,
    };
  }

  return { id, type, position: pos, data: nodeData };
}

export function summarizeGraphForAgent(graph) {
  const g = cloneGraph(graph);
  return {
    node_count: g.nodes.length,
    edge_count: g.edges.length,
    nodes: g.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.data?.label || n.id,
      agentId: n.data?.agentId,
      toolName: n.data?.toolName,
    })),
    edges: g.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
    })),
  };
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
    if (!op) throw new Error('Each action needs action/op/type');

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

    if (!currentId || !def) throw new Error('No workflow in context — use create_workflow first or pass workflow_id');

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
      if (action.task_config) node.data.taskConfig = { ...node.data.taskConfig, ...action.task_config };
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
      results.push({ action: op, ok: true, status: def.status });
      continue;
    }

    if (op === 'trigger_workflow' || op === 'trigger_run') {
      const run = await triggerAgentWorkflowForOwner(ownerUserId, {
        message: action.message || action.input || '',
        workflow_id: action.workflow_id || currentId,
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

    throw new Error(`Unknown action: ${op}`);
  }

  def = store.getDefinition(currentId, ownerUserId);
  return {
    workflow_id: currentId,
    workflow: def,
    draft_graph: def?.draft_graph,
    graph_summary: summarizeGraphForAgent(def?.draft_graph),
    results,
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
    trigger_modes: def.trigger_modes,
    chat_trigger_phrase: def.chat_trigger_phrase,
    schedule_cron: def.schedule_cron,
    graph_summary: summarizeGraphForAgent(def.draft_graph),
    draft_graph: def.draft_graph,
  };
}
