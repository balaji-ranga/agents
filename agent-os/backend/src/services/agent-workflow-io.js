/**
 * Resolve workflow step inputs (static vs dynamic from previous step outputs).
 */

function getOutputValue(context, nodeId, outputKey = 'text') {
  const raw = context.node_outputs?.[nodeId];
  if (raw == null) return '';
  if (typeof raw === 'string') {
    if (outputKey === 'text' || outputKey === 'result' || outputKey === 'body') return raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && outputKey in parsed) return String(parsed[outputKey] ?? '');
      return raw;
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object') {
    if (outputKey in raw) return raw[outputKey] != null ? String(raw[outputKey]) : '';
    if (raw.text != null) return String(raw.text);
    return JSON.stringify(raw);
  }
  return String(raw);
}

/**
 * Resolve all input bindings for a node.
 * @returns {{ resolved: Record<string,string>, bindings: Array, summary: Array }}
 */
export function resolveNodeInputs(node, graph, context) {
  const data = node.data || {};
  const bindings = data.inputBindings || [];
  const resolved = {};
  const summary = [];

  for (const binding of bindings) {
    const key = binding.id;
    let value = '';
    let source = 'static';

    if (binding.mode === 'dynamic' && binding.sourceNodeId) {
      value = getOutputValue(context, binding.sourceNodeId, binding.sourceOutputKey || 'text');
      source = `step:${binding.sourceNodeId}.${binding.sourceOutputKey || 'text'}`;
    } else if (binding.mode === 'dynamic') {
      const incoming = graph.edges.filter((e) => e.target === node.id);
      if (incoming.length === 1) {
        value = getOutputValue(context, incoming[0].source, binding.sourceOutputKey || 'text');
        source = `previous:${incoming[0].source}`;
      } else if (incoming.length > 1) {
        value = incoming
          .map((e) => getOutputValue(context, e.source, binding.sourceOutputKey || 'text'))
          .filter(Boolean)
          .join('\n\n');
        source = 'merge:previous';
      }
    } else {
      value = binding.value != null ? String(binding.value) : '';
      source = 'static';
    }

    resolved[key] = value;
    summary.push({ id: key, label: binding.label || key, mode: binding.mode, source, valuePreview: value.slice(0, 120) });
  }

  if (context.initial_input && !resolved.prompt && node.type === 'agent') {
    resolved.prompt = String(context.initial_input);
  }

  return { resolved, bindings, summary };
}

/** Legacy {{input}} text for agent prompts. */
export function resolveInputText(node, graph, context) {
  const { resolved } = resolveNodeInputs(node, graph, context);
  const data = node.data || {};

  if (resolved.body) return resolved.body;
  if (resolved.prompt) {
    let prompt = data.prompt || data.instructions || '';
    prompt = prompt.replace(/\{\{input\}\}/g, resolved.prompt);
    if (!prompt.trim()) return resolved.prompt;
    if (!prompt.includes(resolved.prompt)) {
      return `${prompt}\n\n---\nInput:\n${resolved.prompt}\n---`.trim();
    }
    return prompt;
  }

  const parts = Object.entries(resolved)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join('\n\n') || '(no input)';
}

/** Structured outputs stored on context.node_outputs[nodeId]. */
export function storeNodeOutput(context, nodeId, outputs) {
  context.node_outputs = context.node_outputs || {};
  context.node_outputs[nodeId] = outputs;
  return context;
}

export function outputToContextValue(outputs) {
  if (outputs == null) return '';
  if (typeof outputs === 'string') return outputs;
  if (outputs.text != null) return String(outputs.text);
  return JSON.stringify(outputs);
}

export function getNodeOutputList(node) {
  return node.data?.outputs || [];
}

export function getNodeInputList(node) {
  return node.data?.inputBindings || [];
}
