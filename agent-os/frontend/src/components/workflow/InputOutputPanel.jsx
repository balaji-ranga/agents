import { TASK_TYPES } from './workflowTaskMeta.js';
import {
  formatNodeStepLabel,
  getSourceOutputKeyOptions,
  listPriorNodes,
} from './workflowEditorUtils.js';

function resolveBindingSourceNode(binding, node, allNodes, edges) {
  if (binding.sourceNodeId) {
    return allNodes.find((n) => n.id === binding.sourceNodeId) || null;
  }
  const incoming = allNodes.filter((n) => edges.some((e) => e.target === node.id && e.source === n.id));
  return incoming.length === 1 ? incoming[0] : null;
}

export function InputOutputPanel({ node, taskCatalog, allNodes, edges, onChange }) {
  const data = node?.data || {};
  const catalog = taskCatalog?.find((t) => t.type === node?.type) || {};
  const inputBindings = data.inputBindings || [];
  const outputs = data.outputs || catalog.outputs || [];
  const taskConfig = data.taskConfig || {};

  const setBindings = (bindings) => onChange({ inputBindings: bindings });
  const setConfig = (patch) => onChange({ taskConfig: { ...taskConfig, ...patch } });
  const setOutputs = (outs) => onChange({ outputs: outs });

  const upstreamNodes = allNodes.filter(
    (n) => n.id !== node.id && edges.some((e) => e.target === node.id && e.source === n.id)
  );
  const allPriorNodes = listPriorNodes(allNodes, node.id);

  const updateBinding = (idx, patch) => {
    const next = [...inputBindings];
    next[idx] = { ...next[idx], ...patch };
    setBindings(next);
  };

  if (!node) return null;

  return (
    <div className="wf-io-panel">
      <h4>Inputs</h4>
      {inputBindings.length === 0 && <p className="wf-io-empty">No inputs for this task type.</p>}
      {inputBindings.map((b, idx) => (
        <div key={b.id || idx} className="wf-io-row">
          <div className="wf-io-label">
            {b.label || b.id}
            {catalog.inputs?.[idx]?.required && <span className="wf-req">*</span>}
          </div>
          <select value={b.mode || 'static'} onChange={(e) => updateBinding(idx, { mode: e.target.value })}>
            <option value="static">Static</option>
            <option value="dynamic">From previous step</option>
          </select>
          {b.mode === 'dynamic' ? (
            <>
              <select
                value={b.sourceNodeId || ''}
                onChange={(e) => {
                  const sourceNodeId = e.target.value;
                  const sourceNode = allNodes.find((n) => n.id === sourceNodeId);
                  const keys = getSourceOutputKeyOptions(sourceNode, taskCatalog).map((o) => o.value);
                  const patch = { sourceNodeId };
                  if (keys.length && !keys.includes(b.sourceOutputKey)) {
                    patch.sourceOutputKey = keys.includes('text') ? 'text' : keys[0];
                  }
                  updateBinding(idx, patch);
                }}
              >
                <option value="">— auto (direct predecessor) —</option>
                {allPriorNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {formatNodeStepLabel(n)}
                  </option>
                ))}
              </select>
              {(() => {
                const sourceNode = resolveBindingSourceNode(b, node, allNodes, edges);
                const options = getSourceOutputKeyOptions(sourceNode, taskCatalog);
                const currentKey = b.sourceOutputKey || 'text';
                const hasCurrent = options.some((o) => o.value === currentKey);
                const displayOptions =
                  hasCurrent || !currentKey
                    ? options
                    : [...options, { value: currentKey, label: `${currentKey} (saved)` }];
                if (!displayOptions.length) {
                  return (
                    <input
                      value={currentKey}
                      onChange={(e) => updateBinding(idx, { sourceOutputKey: e.target.value })}
                      placeholder="output key (e.g. text)"
                      title="Select a source step first, or type any output key"
                    />
                  );
                }
                return (
                  <select
                    value={currentKey}
                    onChange={(e) => updateBinding(idx, { sourceOutputKey: e.target.value })}
                    title={
                      sourceNode
                        ? `Outputs from ${sourceNode.data?.label || sourceNode.id}`
                        : 'Pick a source step to see its outputs'
                    }
                  >
                    {displayOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                );
              })()}
            </>
          ) : (
            b.id === 'body' || b.id === 'payload' ? (
              <textarea
                rows={3}
                value={b.value || ''}
                onChange={(e) => updateBinding(idx, { value: e.target.value })}
                placeholder={catalog.inputs?.[idx]?.placeholder || ''}
              />
            ) : (
              <input
                value={b.value || ''}
                onChange={(e) => updateBinding(idx, { value: e.target.value })}
                placeholder={catalog.inputs?.[idx]?.placeholder || ''}
              />
            )
          )}
        </div>
      ))}

      {(catalog.configFields || []).length > 0 && (
        <>
          <h4 style={{ marginTop: '1rem' }}>Task configuration</h4>
          {catalog.configFields.map((f) => (
            <label key={f.id} className="wf-field">
              {f.label}
              {f.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={!!taskConfig[f.id]}
                  onChange={(e) => setConfig({ [f.id]: e.target.checked })}
                />
              ) : f.type === 'select' ? (
                <select value={taskConfig[f.id] || f.default || ''} onChange={(e) => setConfig({ [f.id]: e.target.value })}>
                  {(f.options || []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'}
                  value={taskConfig[f.id] ?? ''}
                  onChange={(e) =>
                    setConfig({ [f.id]: f.type === 'number' ? Number(e.target.value) : e.target.value })
                  }
                  placeholder={f.placeholder || ''}
                />
              )}
              {f.id === 'useEnvSmtp' && (
                <small>Uses WORKFLOW_SMTP_* from backend .env when enabled</small>
              )}
            </label>
          ))}
        </>
      )}

      <h4 style={{ marginTop: '1rem' }}>Outputs</h4>
      <ul className="wf-output-list">
        {(outputs.length ? outputs : catalog.outputs || []).map((o) => (
          <li key={o.id}>
            <strong>{o.id}</strong> — {o.label}
            {o.description && <small>{o.description}</small>}
          </li>
        ))}
      </ul>
      {upstreamNodes.length > 0 && (
        <p className="wf-io-hint">
          Connected from: {upstreamNodes.map((n) => n.data?.label || n.id).join(', ')}
        </p>
      )}
    </div>
  );
}

export function applyCatalogToNewNode(type, catalogEntry, position) {
  const meta = TASK_TYPES[type] || { label: type };
  const id = `${type}-${Date.now().toString(36)}`;
  const data = {
    label: meta.label,
    inputBindings: (catalogEntry?.inputs || []).map((inp) => ({
      id: inp.id,
      label: inp.label,
      mode: inp.defaultMode || inp.mode || 'static',
      value: '',
      sourceNodeId: '',
      sourceOutputKey: 'text',
    })),
    outputs: (catalogEntry?.outputs || []).map((o) => ({ ...o })),
    taskConfig: {},
  };
  for (const f of catalogEntry?.configFields || []) {
    data.taskConfig[f.id] = f.default ?? (f.type === 'boolean' ? false : f.type === 'number' ? f.default || 587 : '');
  }
  if (type === 'email') {
    data.taskConfig.useEnvSmtp = true;
    data.taskConfig.smtpPort = 587;
  }
  if (type === 'agent') {
    data.prompt = 'Complete this task:\n\n{{input}}';
    data.agentId = '';
    data.agentName = '';
  }
  if (type === 'tool') {
    data.toolName = '';
    data.toolPayload = {};
  }
  if (type === 'trigger') {
    data.triggerModes = ['manual'];
    data.scheduleCron = '';
    data.chatPhrase = '';
  }
  return { id, type, position, data };
}
