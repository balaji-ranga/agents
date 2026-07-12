/**
 * Portable workflow definition JSON (export / import).
 * Format: { format: "agent-os-workflow", version: 1, workflow: { ... } }
 */

export const WORKFLOW_EXPORT_FORMAT = 'agent-os-workflow';
export const WORKFLOW_EXPORT_VERSION = 1;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeGraph(graph) {
  const g = asObject(graph);
  return {
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    edges: Array.isArray(g.edges) ? g.edges : [],
    viewport: g.viewport && typeof g.viewport === 'object' ? g.viewport : { x: 0, y: 0, zoom: 1 },
  };
}

function normalizeTriggerModes(modes) {
  if (Array.isArray(modes) && modes.length) {
    return modes.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof modes === 'string' && modes.trim()) {
    return modes.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ['manual'];
}

/**
 * Build a portable export document from editor state or an API definition.
 */
export function buildWorkflowExportDocument({
  name,
  description = '',
  graph,
  variables = {},
  trigger_modes,
  schedule_cron = '',
  chat_trigger_phrase = '',
  source_id = null,
} = {}) {
  return {
    format: WORKFLOW_EXPORT_FORMAT,
    version: WORKFLOW_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    source_id: source_id || undefined,
    workflow: {
      name: String(name || 'Untitled workflow').trim() || 'Untitled workflow',
      description: String(description || '').trim(),
      trigger_modes: normalizeTriggerModes(trigger_modes),
      schedule_cron: String(schedule_cron || ''),
      chat_trigger_phrase: String(chat_trigger_phrase || ''),
      variables: asObject(variables),
      graph: normalizeGraph(graph),
    },
  };
}

/**
 * Accept exported docs, raw workflow objects, or API definition shapes.
 * @returns {{ name, description, graph, variables, trigger_modes, schedule_cron, chat_trigger_phrase }}
 */
export function parseWorkflowImportDocument(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON file');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Workflow JSON must be an object');
  }

  const envelope =
    data.format === WORKFLOW_EXPORT_FORMAT || data.workflow
      ? asObject(data.workflow)
      : data;

  const graph =
    envelope.graph ||
    envelope.draft_graph ||
    (Array.isArray(envelope.nodes) ? envelope : null);

  if (!graph || (!Array.isArray(graph.nodes) && !Array.isArray(envelope.nodes))) {
    throw new Error('Workflow JSON must include a graph with nodes');
  }

  const normalizedGraph = normalizeGraph(graph.nodes ? graph : envelope);
  if (!normalizedGraph.nodes.length) {
    throw new Error('Workflow graph has no nodes');
  }

  const name =
    String(envelope.name || data.name || '').trim() ||
    'Imported workflow';

  return {
    name,
    description: String(envelope.description ?? data.description ?? '').trim(),
    graph: normalizedGraph,
    variables: asObject(envelope.variables ?? data.variables),
    trigger_modes: normalizeTriggerModes(
      envelope.trigger_modes ?? data.trigger_modes ?? ['manual']
    ),
    schedule_cron: String(envelope.schedule_cron ?? data.schedule_cron ?? ''),
    chat_trigger_phrase: String(
      envelope.chat_trigger_phrase ?? data.chat_trigger_phrase ?? ''
    ),
  };
}

export function downloadWorkflowJson(doc, filenameHint) {
  const name = String(filenameHint || doc?.workflow?.name || 'workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name || 'workflow'}.workflow.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result || '')));
      } catch {
        reject(new Error('Invalid JSON file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
