/** Parse workflow step input/output JSON for display. */

export function parseIoJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: String(raw) };
  }
}

function formatBindingList(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((i) => {
      const label = i.label || i.id || 'input';
      const val = i.valuePreview ?? i.value ?? i.source ?? '';
      return `${label}: ${val}`;
    })
    .join('\n');
}

/** One-line summary for compact lists. */
export function summarizeStepIo(io, kind = 'input') {
  const data = parseIoJson(io);
  if (!data) return '—';
  if (kind === 'input') {
    if (Array.isArray(data.inputs) && data.inputs.length) {
      return formatBindingList(data.inputs).slice(0, 160);
    }
    if (data.initial_input != null) return String(data.initial_input).slice(0, 160);
    if (data.trigger) return `trigger=${data.trigger}`;
    if (data.resolved) return JSON.stringify(data.resolved).slice(0, 160);
    return JSON.stringify(data).slice(0, 160);
  }
  if (Array.isArray(data.outputs) && data.outputs.length) {
    return data.outputs.map((o) => `${o.id}=${String(o.value ?? '').slice(0, 48)}`).join(' · ');
  }
  if (data.text) return String(data.text).slice(0, 160);
  return JSON.stringify(data).slice(0, 160);
}

/** Full multi-line text for tooltips and detail panels. */
export function formatStepIoFull(io, kind = 'input') {
  const data = parseIoJson(io);
  if (!data) return null;

  const sections = [];

  if (kind === 'input') {
    if (data.trigger != null || data.initial_input != null) {
      const lines = [];
      if (data.trigger) lines.push(`Trigger: ${data.trigger}`);
      if (data.initial_input != null) lines.push(`Initial input:\n${data.initial_input}`);
      sections.push({ title: 'Trigger', body: lines.join('\n\n') });
    }
    const bindings = formatBindingList(data.inputs);
    if (bindings) sections.push({ title: 'Bindings', body: bindings });
    if (data.resolved && Object.keys(data.resolved).length) {
      sections.push({ title: 'Resolved values', body: JSON.stringify(data.resolved, null, 2) });
    }
    if (!sections.length) {
      sections.push({ title: 'Input', body: JSON.stringify(data, null, 2) });
    }
  } else {
    if (Array.isArray(data.outputs) && data.outputs.length) {
      const body = data.outputs.map((o) => `${o.id}:\n${o.value ?? ''}`).join('\n\n');
      sections.push({ title: 'Outputs', body });
    }
    const { outputs: _o, ...rest } = data;
    if (Object.keys(rest).length) {
      sections.push({ title: 'Details', body: JSON.stringify(rest, null, 2) });
    }
    if (!sections.length) {
      sections.push({ title: 'Output', body: JSON.stringify(data, null, 2) });
    }
  }

  return sections;
}
