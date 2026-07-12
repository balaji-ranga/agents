/**
 * Edit workflow-level static variables (saved with draft / published snapshot).
 * Readable in nodes as {{var.key}}.
 */
import { useState } from 'react';

function inferType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (value != null && typeof value === 'object') return 'json';
  return 'string';
}

function toRows(variables = {}) {
  return Object.entries(variables || {}).map(([key, value]) => ({
    id: `${key}-${Math.random().toString(36).slice(2, 7)}`,
    key,
    type: inferType(value),
    value:
      value != null && typeof value === 'object'
        ? JSON.stringify(value)
        : value == null
          ? ''
          : String(value),
  }));
}

function rowsToObject(rows) {
  const out = {};
  for (const row of rows) {
    const key = String(row.key || '').trim();
    if (!key) continue;
    if (row.type === 'boolean') {
      out[key] = row.value === true || row.value === 'true' || row.value === '1';
    } else if (row.type === 'number') {
      const n = Number(row.value);
      out[key] = Number.isFinite(n) ? n : row.value;
    } else if (row.type === 'json') {
      try {
        out[key] = JSON.parse(row.value || 'null');
      } catch {
        out[key] = row.value;
      }
    } else {
      out[key] = row.value;
    }
  }
  return out;
}

export default function WorkflowVariablesPanel({ variables, onChange }) {
  const [rows, setRows] = useState(() => toRows(variables));
  const [error, setError] = useState('');

  const commit = (nextRows) => {
    setRows(nextRows);
    setError('');
    try {
      for (const row of nextRows) {
        if (row.type === 'json' && String(row.value || '').trim()) {
          JSON.parse(row.value);
        }
      }
      onChange(rowsToObject(nextRows));
    } catch (e) {
      setError(e.message || 'Invalid JSON in a variable value');
    }
  };

  const updateRow = (id, patch) => {
    commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id) => {
    commit(rows.filter((r) => r.id !== id));
  };

  const addRow = () => {
    commit([
      ...rows,
      {
        id: `new-${Date.now()}`,
        key: '',
        type: 'string',
        value: '',
      },
    ]);
  };

  return (
    <div className="wf-variables">
      <h3>Workflow variables</h3>
      <p className="wf-variables-hint">
        Static config for this workflow. Use in prompts/API bodies as{' '}
        <code>{'{{var.key}}'}</code>. Saved with draft; used at run time from the definition.
      </p>
      {error && <div className="wf-variables-error">{error}</div>}
      <div className="wf-variables-list">
        {rows.length === 0 && <p className="wf-variables-empty">No variables yet.</p>}
        {rows.map((row) => (
          <div key={row.id} className="wf-variables-row">
            <input
              className="wf-variables-key"
              placeholder="key"
              value={row.key}
              onChange={(e) => updateRow(row.id, { key: e.target.value })}
            />
            <select
              className="wf-variables-type"
              value={row.type}
              onChange={(e) => updateRow(row.id, { type: e.target.value })}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="json">json</option>
            </select>
            {row.type === 'boolean' ? (
              <select
                className="wf-variables-value"
                value={row.value === true || row.value === 'true' ? 'true' : 'false'}
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : row.type === 'json' ? (
              <textarea
                className="wf-variables-value wf-variables-json"
                rows={2}
                placeholder='["NASDAQ:NVDA"] or {"a":1}'
                value={row.value}
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
              />
            ) : (
              <input
                className="wf-variables-value"
                placeholder="value"
                value={row.value}
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
              />
            )}
            <button type="button" className="wf-variables-remove" onClick={() => removeRow(row.id)} title="Remove">
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="wf-btn wf-variables-add" onClick={addRow}>
        Add variable
      </button>
    </div>
  );
}
