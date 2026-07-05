import { useState, useEffect } from 'react';
import { Fragment } from 'react';
import { api } from '../api';

function parsePayload(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (_) {
    return str;
  }
}

function PayloadBlock({ label, data }) {
  const [open, setOpen] = useState(false);
  const obj = typeof data === 'string' ? parsePayload(data) : data;
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const preview = typeof obj === 'object' && obj !== null
    ? (obj.url || obj.error || obj.summary || str.slice(0, 80) + (str.length > 80 ? '…' : ''))
    : str.slice(0, 80) + (str.length > 80 ? '…' : '');
  return (
    <div style={{ marginTop: '0.25rem' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: '0.85rem',
          color: 'var(--accent)',
          textAlign: 'left',
        }}
      >
        {label}: {open ? '▼' : '▶'} {preview}
      </button>
      {open && (
        <pre
          style={{
            marginTop: '0.25rem',
            padding: '0.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontSize: '0.8rem',
            overflow: 'auto',
            maxHeight: 200,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {str}
        </pre>
      )}
    </div>
  );
}

const DEFAULT_TEST_BODIES = {
  summarize_url: { url: 'https://example.com' },
  generate_image: { prompt: 'a sunset over mountains' },
  generate_video: { prompt: 'waves on a beach' },
};

export default function ContentToolsLogs() {
  const [tools, setTools] = useState([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState(null);
  const [testName, setTestName] = useState(null);
  const [testBody, setTestBody] = useState('{}');
  const [testResult, setTestResult] = useState(null);
  const [testLoading, setTestLoading] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [onboardForm, setOnboardForm] = useState({ name: '', display_name: '', endpoint: '', method: 'POST', purpose: '', model_used: '' });
  const [onboardSubmitting, setOnboardSubmitting] = useState(false);
  const [onboardError, setOnboardError] = useState(null);

  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toolFilter, setToolFilter] = useState('');
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);

  const fetchTools = () => {
    setToolsLoading(true);
    setToolsError(null);
    api
      .contentToolsMeta()
      .then(({ tools: list }) => setTools(list || []))
      .catch((e) => setToolsError(e.message))
      .finally(() => setToolsLoading(false));
  };

  useEffect(() => {
    fetchTools();
  }, []);

  const fetchLogs = () => {
    setLoading(true);
    setError(null);
    api
      .contentToolsLogs({ limit, offset, tool: toolFilter || undefined })
      .then(({ logs: nextLogs, total: nextTotal }) => {
        setLogs(nextLogs);
        setTotal(nextTotal);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLogs();
  }, [offset, toolFilter]);

  const handleToggleEnabled = (t) => {
    api
      .contentToolsMetaUpdate(t.name, { enabled: !t.enabled })
      .then(() => fetchTools())
      .catch((e) => setToolsError(e.message));
  };

  const openTest = (t) => {
    setTestName(t.name);
    setTestBody(JSON.stringify(DEFAULT_TEST_BODIES[t.name] || {}, null, 2));
    setTestResult(null);
  };

  const runTest = () => {
    if (!testName) return;
    let body = {};
    try {
      body = JSON.parse(testBody || '{}');
    } catch {
      setTestResult({ error: 'Invalid JSON' });
      return;
    }
    setTestLoading(true);
    setTestResult(null);
    api
      .contentToolsTest(testName, body)
      .then((data) => setTestResult(data))
      .catch((e) => setTestResult({ error: e.message }))
      .finally(() => setTestLoading(false));
  };

  const submitOnboard = () => {
    const { name, display_name, endpoint } = onboardForm;
    if (!name?.trim() || !display_name?.trim() || !endpoint?.trim()) {
      setOnboardError('Name, display name, and endpoint are required.');
      return;
    }
    setOnboardSubmitting(true);
    setOnboardError(null);
    api
      .contentToolsMetaCreate(onboardForm)
      .then(() => {
        setOnboardOpen(false);
        setOnboardForm({ name: '', display_name: '', endpoint: '', method: 'POST', purpose: '', model_used: '' });
        fetchTools();
      })
      .catch((e) => setOnboardError(e.message))
      .finally(() => setOnboardSubmitting(false));
  };

  if (toolsLoading && tools.length === 0) {
    return (
      <div style={{ padding: '2rem' }}>Loading…</div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: 1200 }}>
      <h1 style={{ marginTop: 0 }}>Content tools</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Manage tools (endpoint, purpose, model), test them, enable/disable serving, and onboard new published endpoints. Restart the OpenClaw gateway after changes so agents see the updated list.
      </p>

      {toolsError && (
        <div style={{ padding: '1rem', marginBottom: '1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: '#f87171' }}>
          {toolsError}
        </div>
      )}

      <section style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Tools registry</h2>
          <button
            type="button"
            onClick={() => setOnboardOpen(true)}
            style={{
              padding: '0.4rem 0.75rem',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            Onboard new tool
          </button>
        </div>

        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Name</th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Endpoint</th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Purpose</th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Model</th>
                <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Serving</th>
                <th style={{ padding: '0.75rem 1rem', width: 140 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.6rem 1rem' }}>
                    <span style={{ fontWeight: 500 }}>{t.display_name || t.name}</span>
                    {t.is_builtin ? (
                      <span style={{ marginLeft: '0.35rem', fontSize: '0.75rem', color: 'var(--muted)' }}>built-in</span>
                    ) : null}
                  </td>
                  <td style={{ padding: '0.6rem 1rem', fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all' }}>{t.endpoint || '—'}</td>
                  <td style={{ padding: '0.6rem 1rem', color: 'var(--muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.purpose || ''}>{t.purpose || '—'}</td>
                  <td style={{ padding: '0.6rem 1rem', fontSize: '0.85rem' }}>{t.model_used || '—'}</td>
                  <td style={{ padding: '0.6rem 1rem' }}>
                    <button
                      type="button"
                      onClick={() => handleToggleEnabled(t)}
                      style={{
                        padding: '0.2rem 0.5rem',
                        borderRadius: 4,
                        fontSize: '0.8rem',
                        background: t.enabled ? 'rgba(34, 197, 94, 0.2)' : 'var(--surface)',
                        border: '1px solid var(--border)',
                        color: t.enabled ? 'var(--accent)' : 'var(--muted)',
                        cursor: 'pointer',
                      }}
                    >
                      {t.enabled ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td style={{ padding: '0.6rem 1rem' }}>
                    <button
                      type="button"
                      disabled={!t.enabled}
                      onClick={() => openTest(t)}
                      style={{
                        padding: '0.25rem 0.5rem',
                        fontSize: '0.85rem',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        cursor: t.enabled ? 'pointer' : 'not-allowed',
                        color: 'var(--text)',
                      }}
                    >
                      Test
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tools.length === 0 && (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
              No tools in registry. Onboard a new tool or ensure the backend has run the content tools seed.
            </div>
          )}
        </div>
      </section>

      {testName && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
          onClick={() => setTestName(null)}
        >
          <div
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '1.5rem',
              maxWidth: 480,
              width: '90%',
              maxHeight: '80vh',
              overflow: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Test: {testName}</h3>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Request body (JSON)</label>
            <textarea
              value={testBody}
              onChange={(e) => setTestBody(e.target.value)}
              rows={6}
              style={{
                width: '100%',
                padding: '0.5rem',
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button
                type="button"
                onClick={runTest}
                disabled={testLoading}
                style={{
                  padding: '0.4rem 0.75rem',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: testLoading ? 'wait' : 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                {testLoading ? 'Running…' : 'Run test'}
              </button>
              <button
                type="button"
                onClick={() => setTestName(null)}
                style={{
                  padding: '0.4rem 0.75rem',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: 'var(--text)',
                }}
              >
                Close
              </button>
            </div>
            {testResult !== null && (
              <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <strong style={{ fontSize: '0.85rem' }}>Result</strong>
                <pre style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {typeof testResult === 'object' ? JSON.stringify(testResult, null, 2) : String(testResult)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {onboardOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
          onClick={() => !onboardSubmitting && setOnboardOpen(false)}
        >
          <div
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '1.5rem',
              maxWidth: 480,
              width: '90%',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Onboard new tool</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1rem' }}>
              Add a published endpoint. It will be registered in the registry and in OpenClaw (after gateway restart). Use full URL for external endpoints.
            </p>
            {onboardError && (
              <div style={{ padding: '0.5rem', marginBottom: '1rem', background: 'rgba(248,113,113,0.15)', borderRadius: 6, color: '#f87171', fontSize: '0.9rem' }}>
                {onboardError}
              </div>
            )}
            {['name', 'display_name', 'endpoint', 'method', 'purpose', 'model_used'].map((key) => (
              <label key={key} style={{ display: 'block', marginBottom: '0.75rem' }}>
                <span style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: 'var(--muted)' }}>
                  {key.replace('_', ' ')}
                </span>
                <input
                  type="text"
                  value={onboardForm[key] || ''}
                  onChange={(e) => setOnboardForm((f) => ({ ...f, [key]: e.target.value }))}
                  placeholder={key === 'endpoint' ? 'https://api.example.com/run or /api/tools/...' : ''}
                  style={{
                    width: '100%',
                    padding: '0.4rem 0.5rem',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: 'var(--text)',
                    boxSizing: 'border-box',
                  }}
                />
              </label>
            ))}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button
                type="button"
                onClick={submitOnboard}
                disabled={onboardSubmitting}
                style={{
                  padding: '0.4rem 0.75rem',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: onboardSubmitting ? 'wait' : 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                {onboardSubmitting ? 'Adding…' : 'Add tool'}
              </button>
              <button
                type="button"
                onClick={() => !onboardSubmitting && setOnboardOpen(false)}
                style={{
                  padding: '0.4rem 0.75rem',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: 'var(--text)',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <section>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>Invocation logs</h2>
        {error && (
          <div style={{ padding: '1rem', marginBottom: '1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: '#f87171' }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>Tool</span>
            <select
              value={toolFilter}
              onChange={(e) => { setToolFilter(e.target.value); setOffset(0); }}
              style={{
                padding: '0.4rem 0.75rem',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
              }}
            >
              <option value="">All</option>
              {tools.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => fetchLogs()}
            style={{
              padding: '0.4rem 0.75rem',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            title="Remove old or all API logs"
            disabled={cleanupLoading || total === 0}
            onClick={() => {
              if (!window.confirm('Delete logs older than 7 days? (Cancel to abort)')) return;
              setCleanupLoading(true);
              api.contentToolsLogsCleanup({ older_than_days: 7 })
                .then(({ deleted }) => {
                  if (deleted != null) fetchLogs();
                })
                .catch((e) => setError(e.message))
                .finally(() => setCleanupLoading(false));
            }}
            style={{
              padding: '0.4rem 0.75rem',
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: cleanupLoading || total === 0 ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem',
            }}
          >
            {cleanupLoading ? '…' : 'Cleanup (older than 7 days)'}
          </button>
          <button
            type="button"
            title="Delete all logs"
            disabled={cleanupLoading || total === 0}
            onClick={() => {
              if (!window.confirm('Delete ALL invocation logs? This cannot be undone.')) return;
              setCleanupLoading(true);
              api.contentToolsLogsCleanup({ all: true })
                .then(({ deleted }) => {
                  if (deleted != null) fetchLogs();
                })
                .catch((e) => setError(e.message))
                .finally(() => setCleanupLoading(false));
            }}
            style={{
              padding: '0.4rem 0.75rem',
              background: 'var(--surface)',
              color: '#e11',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: cleanupLoading || total === 0 ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem',
            }}
          >
            Delete all logs
          </button>
          <span style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
            {total} log{total !== 1 ? 's' : ''}
          </span>
        </div>

        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {logs.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
              No content tool calls yet. Invocations will appear here.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Time</th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Tool</th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Source</th>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600 }}>Status</th>
                  <th style={{ padding: '0.75rem 1rem', width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <Fragment key={row.id}>
                    <tr
                      style={{
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                        background: expandedId === row.id ? 'var(--surface)' : undefined,
                      }}
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    >
                      <td style={{ padding: '0.6rem 1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
                        {row.created_at ? new Date(row.created_at).toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '0.6rem 1rem' }}>{row.tool_name || '—'}</td>
                      <td style={{ padding: '0.6rem 1rem', color: 'var(--muted)' }}>{row.source || '—'}</td>
                      <td style={{ padding: '0.6rem 1rem' }}>
                        <span
                          style={{
                            padding: '0.2rem 0.5rem',
                            borderRadius: 4,
                            fontSize: '0.8rem',
                            background: row.status === 'ok' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(248, 113, 113, 0.15)',
                            color: row.status === 'ok' ? 'var(--accent)' : '#f87171',
                          }}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td style={{ padding: '0.6rem 1rem' }}>{expandedId === row.id ? '▼' : '▶'}</td>
                    </tr>
                    {expandedId === row.id && (
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={5} style={{ padding: '0.75rem 1rem', background: 'var(--surface)', verticalAlign: 'top' }}>
                          <PayloadBlock label="Request" data={row.request_payload} />
                          <PayloadBlock label="Response" data={row.response_payload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {total > limit && (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center' }}>
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
              style={{
                padding: '0.4rem 0.75rem',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: offset === 0 ? 'not-allowed' : 'pointer',
                color: 'var(--text)',
              }}
            >
              Previous
            </button>
            <span style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <button
              type="button"
              disabled={offset + limit >= total}
              onClick={() => setOffset((o) => o + limit)}
              style={{
                padding: '0.4rem 0.75rem',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: offset + limit >= total ? 'not-allowed' : 'pointer',
                color: 'var(--text)',
              }}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
