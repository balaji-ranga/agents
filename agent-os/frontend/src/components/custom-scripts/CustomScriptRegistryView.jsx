import { useMemo, useState } from 'react';
import { api } from '../../api';

const LANG_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'python', label: 'Python / LangGraph' },
  { id: 'javascript', label: 'JavaScript' },
];

const EMPTY_FORM = {
  name: '',
  description: '',
  language: 'python',
  runtime_profile: 'restricted',
  source: `def run_graph(inputs, context=None):
    """LangGraph or plain Python — return dict with at least 'text'."""
    payload = inputs.get("payload") or inputs.get("text") or ""
    return {"text": f"Processed: {payload}"}
`,
};

function statusClass(status, scanStatus) {
  if (status === 'approved' && scanStatus === 'approved') return 'mcp-pg-status-healthy';
  if (status === 'disabled' || scanStatus === 'rejected') return 'mcp-pg-status-disabled';
  return 'mcp-pg-status-draft';
}

function riskBadge(risk) {
  if (risk === 'critical' || risk === 'high') return { color: '#dc2626', label: risk };
  if (risk === 'medium') return { color: '#ca8a04', label: risk };
  return { color: '#16a34a', label: risk || 'low' };
}

function ScanResults({ scan }) {
  if (!scan) return null;
  return (
    <div
      style={{
        marginBottom: 12,
        padding: 10,
        borderRadius: 8,
        border: `1px solid ${scan.passed || scan.scan_status === 'approved' ? '#16a34a' : '#dc2626'}`,
        fontSize: '0.8rem',
      }}
    >
      <strong>
        {scan.passed || scan.scan_status === 'approved' ? 'Scan passed' : 'Scan failed'}
      </strong>
      {scan.risk_level && <> — risk: {scan.risk_level}</>}
      {scan.findings?.length > 0 && (
        <ul style={{ marginTop: 8, paddingLeft: 18 }}>
          {scan.findings.map((f, i) => (
            <li key={i} style={{ color: f.severity === 'critical' || f.severity === 'high' ? '#dc2626' : undefined }}>
              [{f.severity}] L{f.line}: {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CustomScriptRegistryView({ scripts, loading, user, onRefresh }) {
  const [search, setSearch] = useState('');
  const [langFilter, setLangFilter] = useState('all');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [viewScript, setViewScript] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [scanPreview, setScanPreview] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState(null);
  const [actionFeedback, setActionFeedback] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (scripts || []).filter((s) => {
      if (langFilter !== 'all' && s.language !== langFilter) return false;
      if (!q) return true;
      return (
        s.name?.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.id?.toLowerCase().includes(q)
      );
    });
  }, [scripts, search, langFilter]);

  const closeModal = () => {
    if (saving || loadingDetail) return;
    setModal(null);
    setViewScript(null);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setScanPreview(null);
    setError(null);
  };

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setScanPreview(null);
    setError(null);
    setEditingId(null);
    setViewScript(null);
    setModal('add');
  };

  const openView = async (script) => {
    setLoadingDetail(true);
    setError(null);
    setModal('view');
    try {
      const full = await api.customScriptGet(script.id, { includeSource: true });
      setViewScript(full);
    } catch (e) {
      setError(e.message);
      setViewScript(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const openEdit = async (script) => {
    setLoadingDetail(true);
    setError(null);
    setScanPreview(null);
    setModal('edit');
    setEditingId(script.id);
    try {
      const full = await api.customScriptGet(script.id, { includeSource: true });
      setForm({
        name: full.name || '',
        description: full.description || '',
        language: full.language || 'python',
        runtime_profile: full.runtime_profile || 'restricted',
        source: full.source || '',
      });
    } catch (e) {
      setError(e.message);
      setModal(null);
      setEditingId(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const scan = await api.customScriptScan({
        source: form.source,
        language: form.language,
        runtime_profile: form.runtime_profile,
      });
      setScanPreview(scan);
    } catch (e) {
      setError(e.message);
      setScanPreview(null);
    } finally {
      setScanning(false);
    }
  };

  const register = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.customScriptCreate(form);
      closeModal();
      setActionFeedback({ type: 'success', message: 'Script registered successfully' });
      onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editingId) return;
    setSaving(true);
    setError(null);
    try {
      await api.customScriptUpdate(editingId, form);
      closeModal();
      setActionFeedback({ type: 'success', message: 'Script updated — re-scanned on save' });
      onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this script?')) return;
    setDeleting(id);
    try {
      await api.customScriptDelete(id);
      setActionFeedback({ type: 'success', message: 'Script deleted' });
      onRefresh?.();
    } catch (e) {
      setActionFeedback({ type: 'error', message: e.message });
    } finally {
      setDeleting(null);
    }
  };

  const testRun = async (script) => {
    setTesting(script.id);
    setTestResult(null);
    try {
      const res = await api.customScriptExecute(script.id, {
        inputs: { payload: 'hello from test' },
        context: { test: true },
      });
      setTestResult({ id: script.id, ok: true, output: res.output });
    } catch (e) {
      setTestResult({ id: script.id, ok: false, error: e.message });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="page-mcp">
      <header className="mcp-pg-header">
        <div>
          <h1>Custom Scripts</h1>
          <p className="mcp-pg-sub">
            Upload LangGraph or JavaScript scripts for workflow steps and Brain fallback. Scripts are scanned for
            hostile patterns before approval.
          </p>
        </div>
        <button type="button" className="mcp-pg-btn-primary" onClick={openAdd}>
          + Add script
        </button>
      </header>

      {actionFeedback && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: '0.85rem',
            background: actionFeedback.type === 'success' ? '#16a34a18' : '#dc262618',
            color: actionFeedback.type === 'success' ? '#166534' : '#b91c1c',
            border: `1px solid ${actionFeedback.type === 'success' ? '#16a34a44' : '#dc262644'}`,
          }}
        >
          {actionFeedback.message}
          <button
            type="button"
            onClick={() => setActionFeedback(null)}
            style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="mcp-pg-toolbar">
        <input
          type="search"
          placeholder="Search scripts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mcp-pg-search"
        />
        <div className="mcp-pg-filters">
          {LANG_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`mcp-pg-filter${langFilter === f.id ? ' active' : ''}`}
              onClick={() => setLangFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p>Loading scripts…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>No scripts yet. Add a Python LangGraph or JavaScript script to get started.</p>
      ) : (
        <div className="mcp-pg-grid">
          {filtered.map((s) => {
            const risk = riskBadge(s.risk_level);
            const canRun = s.status === 'approved' && s.scan_status === 'approved';
            return (
              <article key={s.id} className="mcp-pg-card">
                <div className="mcp-pg-card-head">
                  <h3>{s.name}</h3>
                  <span className={`mcp-pg-status ${statusClass(s.status, s.scan_status)}`}>
                    {s.scan_status === 'rejected' ? 'rejected' : s.status}
                  </span>
                </div>
                <p className="mcp-pg-card-desc">{s.description || 'No description'}</p>
                <div className="mcp-pg-card-meta">
                  <span>{s.language}</span>
                  <span>{s.runtime_profile}</span>
                  <span style={{ color: risk.color }}>risk: {risk.label}</span>
                  {s.is_shared && <span>platform</span>}
                </div>
                <code style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{s.id}</code>
                {s.scan_result?.findings?.length > 0 && s.scan_status === 'rejected' && (
                  <ul style={{ fontSize: '0.75rem', color: '#dc2626', marginTop: 8, paddingLeft: 16 }}>
                    {s.scan_result.findings.slice(0, 4).map((f, i) => (
                      <li key={i}>
                        L{f.line}: {f.message}
                      </li>
                    ))}
                  </ul>
                )}
                {testResult?.id === s.id && (
                  <pre
                    style={{
                      fontSize: '0.7rem',
                      marginTop: 8,
                      padding: 8,
                      background: 'var(--surface)',
                      borderRadius: 6,
                      maxHeight: 120,
                      overflow: 'auto',
                    }}
                  >
                    {testResult.ok ? JSON.stringify(testResult.output, null, 2) : testResult.error}
                  </pre>
                )}
                <div className="mcp-pg-card-actions">
                  <button type="button" onClick={() => openView(s)}>
                    View
                  </button>
                  {s.can_edit && (
                    <button type="button" onClick={() => openEdit(s)}>
                      Edit
                    </button>
                  )}
                  {canRun && (
                    <button type="button" disabled={testing === s.id} onClick={() => testRun(s)}>
                      {testing === s.id ? 'Running…' : 'Test run'}
                    </button>
                  )}
                  {s.can_delete && (
                    <button type="button" className="mcp-pg-btn-danger" disabled={deleting === s.id} onClick={() => remove(s.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {modal === 'view' && (
        <div className="mcp-pg-modal-backdrop" onClick={closeModal}>
          <div className="mcp-pg-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <h2>View script</h2>
            {error && <p style={{ color: '#dc2626' }}>{error}</p>}
            {loadingDetail || !viewScript ? (
              <p>Loading script…</p>
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8, marginBottom: 12, fontSize: '0.85rem' }}>
                  <div>
                    <strong>Name:</strong> {viewScript.name}
                  </div>
                  <div>
                    <strong>ID:</strong> <code>{viewScript.id}</code>
                  </div>
                  <div>
                    <strong>Language:</strong> {viewScript.language} · <strong>Runtime:</strong>{' '}
                    {viewScript.runtime_profile}
                  </div>
                  <div>
                    <strong>Status:</strong> {viewScript.status} · <strong>Scan:</strong> {viewScript.scan_status} ·{' '}
                    <strong>Risk:</strong> {viewScript.risk_level}
                  </div>
                  {viewScript.description && (
                    <div>
                      <strong>Description:</strong> {viewScript.description}
                    </div>
                  )}
                </div>
                <ScanResults scan={viewScript.scan_result} />
                <label className="wf-field">
                  Source code
                  <textarea
                    rows={16}
                    readOnly
                    value={viewScript.source || ''}
                    style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}
                  />
                </label>
                <div className="mcp-pg-modal-actions">
                  {viewScript.can_edit && (
                    <button
                      type="button"
                      onClick={() => {
                        setModal('edit');
                        setEditingId(viewScript.id);
                        setForm({
                          name: viewScript.name || '',
                          description: viewScript.description || '',
                          language: viewScript.language || 'python',
                          runtime_profile: viewScript.runtime_profile || 'restricted',
                          source: viewScript.source || '',
                        });
                        setScanPreview(null);
                        setError(null);
                      }}
                    >
                      Edit
                    </button>
                  )}
                  <button type="button" onClick={closeModal}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {(modal === 'add' || modal === 'edit') && (
        <div className="mcp-pg-modal-backdrop" onClick={closeModal}>
          <form
            className="mcp-pg-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={modal === 'add' ? register : saveEdit}
          >
            <h2>{modal === 'add' ? 'Add custom script' : 'Edit custom script'}</h2>
            {loadingDetail && modal === 'edit' && !form.source ? (
              <p>Loading script…</p>
            ) : (
              <>
                {error && <p style={{ color: '#dc2626' }}>{error}</p>}
                <label className="wf-field">
                  Name
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </label>
                <label className="wf-field">
                  Description
                  <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </label>
                <label className="wf-field">
                  Language
                  <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                    <option value="python">Python / LangGraph</option>
                    <option value="javascript">JavaScript</option>
                  </select>
                </label>
                <label className="wf-field">
                  Runtime profile
                  <select
                    value={form.runtime_profile}
                    onChange={(e) => setForm({ ...form, runtime_profile: e.target.value })}
                  >
                    <option value="restricted">Restricted (no network)</option>
                    <option value="network">Network allowed</option>
                  </select>
                </label>
                <label className="wf-field">
                  Source code
                  <textarea
                    rows={14}
                    value={form.source}
                    onChange={(e) => {
                      setForm({ ...form, source: e.target.value });
                      setScanPreview(null);
                    }}
                    style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}
                  />
                  <small>
                    Python: define <code>run_graph(inputs)</code> or <code>run(inputs)</code>. JS: export{' '}
                    <code>run(inputs, context)</code>.
                  </small>
                </label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <button type="button" onClick={runScan} disabled={scanning}>
                    {scanning ? 'Scanning…' : 'Scan for vulnerabilities'}
                  </button>
                </div>
                {scanPreview && <ScanResults scan={scanPreview} />}
                <div className="mcp-pg-modal-actions">
                  <button type="button" onClick={closeModal} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="mcp-pg-btn-primary" disabled={saving}>
                    {saving ? 'Saving…' : modal === 'add' ? 'Save script' : 'Save changes'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
