/**
 * Factual workflow descriptions for the Workflow Builder agent — no LLM hallucination.
 */
import * as store from './agent-workflow-store.js';
import { getTaskTypeDef } from './agent-workflow-task-catalog.js';
import { resolveWorkflowForTrigger, enquireWorkflows } from './agent-workflow-chat-tools.js';

const NODE_PURPOSE = {
  trigger: 'Entry point — starts runs via manual, chat phrase, schedule, or webhook.',
  agent: 'Delegates a prompt to a workspace agent.',
  brain: 'Direct LLM call (OpenAI, Anthropic, Ollama, OpenRouter); optional MCP tool-calling.',
  tool: 'Invokes a registered content tool.',
  mcp_tool: 'Calls an MCP server tool, prompt, or resource.',
  mcp_listen: 'Long-running SSE listener; dispatches on each event.',
  sse_listen: 'Long-running SSE listener; dispatches on each event.',
  sub_workflow: 'Invokes another published workflow as a child run.',
  email: 'Sends email via SMTP.',
  api: 'HTTP request to an external API.',
  externalAgent: 'Invokes a registered external agent via A2A JSON-RPC.',
  custom_script: 'Runs an approved custom Python/JS/LangGraph script in a sandbox.',
  parallel: 'Fans out to multiple branches concurrently.',
  merge: 'Joins parallel branches before continuing.',
  ceo_approval: 'Pauses for CEO approve/reject on Kanban.',
  if: 'Branches on a condition (true/false handles).',
  while: 'Loops while a condition holds (loop/exit handles).',
};

/** Extract workflow name / id from natural-language or markdown messages. */
export function extractWorkflowReferenceFromMessage(message) {
  const t = String(message || '');
  let workflow_id = null;
  let name = null;

  const idMatch = t.match(/(?:\*\*)?ID(?:\*\*)?\s*[:：]\s*\*?\*?\s*([a-z0-9][a-z0-9-]*)/i);
  if (idMatch) workflow_id = idMatch[1].trim().toLowerCase();

  for (const m of t.matchAll(/\*\*([^*]+)\*\*/g)) {
    const text = m[1].trim();
    if (/^ID$/i.test(text)) continue;
    if (!name && text.length > 1) name = text;
  }

  if (!name) {
    const quoted = t.match(/["']([^"']+)["']/);
    if (quoted) name = quoted[1].trim();
  }

  if (!workflow_id) {
    const slug = t.match(/\b([a-z][a-z0-9-]{10,})\b/g);
    if (slug?.length) {
      const candidate = slug.find((s) => s.includes('-') && !/^(workflowbuilder|techresearcher)/.test(s));
      if (candidate) workflow_id = candidate.toLowerCase();
    }
  }

  return { workflow_id, name };
}

function sanitizeTaskConfig(cfg = {}) {
  if (!cfg || typeof cfg !== 'object') return {};
  const out = { ...cfg };
  for (const secret of ['apiKey', 'api_key', 'bearerToken', 'basicPassword', 'smtpPass', 'auth_header']) {
    if (out[secret]) out[secret] = '(set)';
  }
  return out;
}

function summarizeBindings(bindings = []) {
  return bindings.map((b) => ({
    id: b.id,
    mode: b.mode,
    source: b.mode === 'dynamic' ? `${b.sourceNodeId || '?'}.${b.sourceOutputKey || 'text'}` : undefined,
    value_preview: b.mode === 'static' ? String(b.value || '').slice(0, 80) : undefined,
  }));
}

export function buildDetailedNodeSummary(node) {
  const def = getTaskTypeDef(node.type);
  const cfg = node.data?.taskConfig || node.data?.config || {};
  const data = node.data || {};
  const summary = {
    id: node.id,
    type: node.type,
    catalog_label: def?.label || node.type,
    label: data.label || node.id,
    purpose: NODE_PURPOSE[node.type] || def?.label || node.type,
    inputs: (def?.inputs || []).map((i) => i.id),
    outputs: (def?.outputs || []).map((o) => o.id),
  };

  if (node.type === 'trigger') {
    summary.trigger_modes = data.triggerModes || [];
    summary.schedule_cron = data.scheduleCron || '';
    summary.chat_phrase = data.chatPhrase || '';
  }
  if (node.type === 'agent') {
    summary.agent_id = data.agentId || data.agent_id;
    summary.agent_name = data.agentName;
    summary.prompt_preview = String(data.prompt || '').slice(0, 120);
  }
  if (node.type === 'tool') {
    summary.tool_name = data.toolName;
  }

  const tc = sanitizeTaskConfig(cfg);
  if (node.type === 'externalAgent' && tc.externalAgentName) {
    summary.external_agent = tc.externalAgentName;
  }
  if (node.type === 'externalAgent' && tc.externalAgentId) {
    summary.external_agent_id = tc.externalAgentId;
  }
  if (Object.keys(tc).length) summary.task_config = tc;
  if (data.inputBindings?.length) summary.input_bindings = summarizeBindings(data.inputBindings);

  return summary;
}

export function buildDetailedGraphSummary(graph) {
  const g = graph || { nodes: [], edges: [] };
  const nodes = g.nodes || [];
  const edges = g.edges || [];
  const order = topologicalNodeOrder(g);

  return {
    node_count: nodes.length,
    edge_count: edges.length,
    execution_order: order.map((n) => n.id),
    nodes: order.map(buildDetailedNodeSummary),
    edges: edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      handle: e.sourceHandle || 'default',
    })),
  };
}

function topologicalNodeOrder(graph) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trigger = nodes.find((n) => n.type === 'trigger');
  const order = [];
  const visited = new Set();

  function walk(id) {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (node) order.push(node);
    for (const e of edges.filter((edge) => edge.source === id)) walk(e.target);
  }

  if (trigger) walk(trigger.id);
  for (const n of nodes) {
    if (!visited.has(n.id)) order.push(n);
  }
  return order;
}

export function formatWorkflowDescriptionBlock(def) {
  const graph = def.status === 'published' && def.published_graph ? def.published_graph : def.draft_graph;
  const detailed = buildDetailedGraphSummary(graph);
  const lines = [
    `### ${def.name} (id: ${def.id})`,
    `- Status: ${def.status}${def.paused ? ' (PAUSED)' : ''}`,
    `- Description: ${def.description || '(none)'}`,
    `- Trigger modes: ${(def.trigger_modes || []).join(', ') || 'manual'}`,
    `- Chat phrase: ${def.chat_trigger_phrase || '(none)'}`,
    `- Schedule: ${def.schedule_cron || '(none)'}`,
    `- Graph: ${detailed.node_count} nodes, ${detailed.edge_count} edges`,
    '',
    '**Nodes (execution order):**',
  ];

  for (const n of detailed.nodes) {
    lines.push(`- **${n.label}** (\`${n.id}\`, type: \`${n.type}\` — ${n.catalog_label})`);
    lines.push(`  - Purpose: ${n.purpose}`);
    if (n.task_config && Object.keys(n.task_config).length) {
      lines.push(`  - Config: ${JSON.stringify(n.task_config)}`);
    }
    if (n.input_bindings?.length) {
      lines.push(`  - Inputs: ${JSON.stringify(n.input_bindings)}`);
    }
    if (n.trigger_modes) {
      lines.push(`  - Triggers: ${JSON.stringify({ modes: n.trigger_modes, chat: n.chat_phrase, cron: n.schedule_cron })}`);
    }
    if (n.agent_id) lines.push(`  - Agent: ${n.agent_name || n.agent_id}`);
    if (n.tool_name) lines.push(`  - Tool: ${n.tool_name}`);
  }

  if (detailed.edges.length) {
    lines.push('', '**Edges:**');
    for (const e of detailed.edges) {
      lines.push(`- ${e.from} → ${e.to}${e.handle !== 'default' ? ` (${e.handle})` : ''}`);
    }
  }

  return lines.join('\n');
}

export function formatWorkflowDescriptionReply(def) {
  const block = formatWorkflowDescriptionBlock(def);
  const types = (buildDetailedGraphSummary(def.status === 'published' && def.published_graph ? def.published_graph : def.draft_graph).nodes || [])
    .map((n) => `\`${n.type}\``)
    .join(', ');
  return `${block}\n\n**Summary:** This workflow has exactly ${buildDetailedGraphSummary(def.status === 'published' && def.published_graph ? def.published_graph : def.draft_graph).node_count} node(s): ${types || '(none)'}. No other nodes exist in the stored graph.`;
}

export function parseDescribeWorkflowIntent(message) {
  const t = String(message || '').trim();
  if (!t) return null;

  const ref = extractWorkflowReferenceFromMessage(t);

  const nodesQuery =
    /(?:what|which|list)\s+(?:nodes|steps)/i.test(t) ||
    /(?:nodes|steps)\s+(?:are\s+)?(?:used|in|does|do)/i.test(t) ||
    /(?:show|tell)\s+me\s+(?:the\s+)?(?:nodes|steps)/i.test(t);

  if (nodesQuery) {
    return {
      workflow_query: ref.name || ref.workflow_id || t,
      workflow_id: ref.workflow_id || null,
    };
  }

  if (!/(?:describe|explain|tell\s+me\s+about|what\s+is|what\s+does|how\s+does|show\s+(?:me\s+)?(?:the\s+)?details?|break\s+down)/i.test(t)) {
    return null;
  }
  if (!/workflow/i.test(t) && !ref.name && !ref.workflow_id) return null;

  let m = t.match(
    /^(?:describe|explain|tell\s+me\s+about|what\s+is|show\s+(?:me\s+)?(?:the\s+)?(?:details?\s+(?:of|for|on)\s+)?(?:the\s+)?)(.+?)\s+workflow\s*$/i
  );
  if (m) {
    return { workflow_query: m[1].trim().replace(/^the\s+/i, ''), workflow_id: ref.workflow_id || null };
  }

  m = t.match(/^(?:describe|explain)\s+(?:the\s+)?(.+)$/i);
  if (m) {
    let q = m[1].trim().replace(/\s+workflow\s*$/i, '').replace(/^the\s+/i, '');
    if (q) return { workflow_query: q, workflow_id: ref.workflow_id || null };
  }

  if (ref.name || ref.workflow_id) {
    return { workflow_query: ref.name || ref.workflow_id, workflow_id: ref.workflow_id || null };
  }

  const quoted = t.match(/["']([^"']+)["']/);
  if (quoted) return { workflow_query: quoted[1].trim(), workflow_id: ref.workflow_id || null };

  return { workflow_query: t, workflow_id: ref.workflow_id || null };
}

function resolveDefinitionByReference(ownerUserId, { workflow_id, workflow_query }) {
  if (workflow_id) {
    const byId = store.getDefinition(workflow_id, ownerUserId);
    if (byId) return byId;
    const byResolve = resolveWorkflowForTrigger(ownerUserId, { workflow_id });
    if (byResolve) return byResolve;
  }
  if (workflow_query) {
    const byName = resolveWorkflowForTrigger(ownerUserId, { workflow_name: workflow_query, message: workflow_query });
    if (byName) return byName;
  }
  return null;
}

export function findWorkflowsReferencedInMessage(ownerUserId, message, { limit = 3 } = {}) {
  const intent = parseDescribeWorkflowIntent(message);
  const ref = extractWorkflowReferenceFromMessage(message);
  const queries = [];

  if (intent?.workflow_query) queries.push(intent.workflow_query);
  if (ref.name && !queries.includes(ref.name)) queries.push(ref.name);
  if (ref.workflow_id) queries.push(ref.workflow_id);

  const quoted = String(message || '').match(/["']([^"']+)["']/g);
  if (quoted) {
    for (const q of quoted) queries.push(q.replace(/["']/g, '').trim());
  }

  const seen = new Set();
  const found = [];

  if (ref.workflow_id || intent?.workflow_id) {
    const def = resolveDefinitionByReference(ownerUserId, {
      workflow_id: intent?.workflow_id || ref.workflow_id,
      workflow_query: null,
    });
    if (def && !seen.has(def.id)) {
      seen.add(def.id);
      found.push(def);
    }
  }

  for (const q of queries) {
    const def = resolveWorkflowForTrigger(ownerUserId, { workflow_name: q, message: q, workflow_id: q });
    if (def && !seen.has(def.id)) {
      seen.add(def.id);
      found.push(def);
    }
  }

  if (!found.length && intent) {
    const { matches } = enquireWorkflows(ownerUserId, intent.workflow_query, { limit });
    for (const m of matches) {
      const def = resolveWorkflowForTrigger(ownerUserId, { workflow_id: m.id });
      if (def && !seen.has(def.id)) {
        seen.add(def.id);
        found.push(def);
      }
    }
  }

  return found.slice(0, limit);
}

export function tryDescribeWorkflowResponse(ownerUserId, workflowId, message) {
  const intent = parseDescribeWorkflowIntent(message);
  if (!intent) return null;

  let def =
    resolveDefinitionByReference(ownerUserId, intent) ||
    (workflowId ? store.getDefinition(workflowId, ownerUserId) : null);

  if (!def) {
    const { matches } = enquireWorkflows(ownerUserId, intent.workflow_query, { limit: 1 });
    if (matches[0]) {
      def = store.getDefinition(matches[0].id, ownerUserId);
    }
  }

  if (!def) {
    return {
      reply: `No workflow matched "${intent.workflow_query}". Use exact name or id from the workflows list.`,
      workflow_id: workflowId,
      actions: [],
    };
  }

  return {
    reply: formatWorkflowDescriptionReply(def),
    workflow_id: def.id,
    workflow: def,
    actions: [],
    modelUsed: null,
  };
}
