import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import MaskedSecretInput from '../MaskedSecretInput';

const TRANSPORT_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'streamable_http', label: 'HTTP' },
  { id: 'sse', label: 'SSE' },
  { id: 'stdio', label: 'STDIO' },
];

const EMPTY_FORM = { name: '', description: '', url: '', transport: 'streamable_http' };

function transportLabel(t) {
  if (t === 'sse') return 'SSE';
  if (t === 'stdio') return 'STDIO';
  return 'HTTP';
}

function statusClass(status) {
  if (status === 'healthy') return 'mcp-pg-status-healthy';
  if (status === 'disabled') return 'mcp-pg-status-disabled';
  return 'mcp-pg-status-draft';
}

export default function McpRegistryView({ servers, loading, user, onRefresh }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [transport, setTransport] = useState('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (servers || []).filter((s) => {
      if (transport !== 'all' && (s.transport || 'streamable_http') !== transport) return false;
      if (!q) return true;
      return (
        s.name?.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.url?.toLowerCase().includes(q)
      );
    });
  }, [servers, search, transport]);

  const register = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.mcpServerCreate({
        name: form.name,
        description: form.description,
        url: form.url,
        transport: form.transport,
      });
      setModalOpen(false);
      setForm(EMPTY_FORM);
      onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this MCP server from the registry?')) return;
    setDeleting(id);
    try {
      await api.mcpServerDelete(id);
      onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="mcp-pg mcp-pg-registry">
      <header className="mcp-pg-hero">
        <div className="mcp-pg-hero-text">
          <p className="mcp-pg-kicker">Agent OS · MCP Registry</p>
          <h1>MCP Servers List</h1>
          <p className="mcp-pg-subtitle">
            Browse registered MCP servers, connect with transient auth, and test tools before wiring them into
            workflows.
            {user?.role === 'admin'
              ? ' Admin registrations are shared platform-wide.'
              : ' You see your servers plus admin-shared platform MCPs.'}
          </p>
        </div>
        <button type="button" className="mcp-pg-btn-primary" onClick={() => setModalOpen(true)}>
          + Register server
        </button>
      </header>

      {error && <div className="mcp-pg-alert mcp-pg-alert-error">{error}</div>}

      <div className="mcp-pg-toolbar">
        <input
          type="search"
          className="mcp-pg-search"
          placeholder="Search servers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="mcp-pg-filter-group">
          <span className="mcp-pg-filter-label">Transport</span>
          <div className="mcp-pg-pills">
            {TRANSPORT_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`mcp-pg-pill${transport === f.id ? ' active' : ''}`}
                onClick={() => setTransport(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="mcp-pg-loading">
          <div className="mcp-pg-spinner" />
          <p>Loading servers from registry…</p>
        </div>
      ) : (
        <>
          <p className="mcp-pg-count">
            {filtered.length} server{filtered.length === 1 ? '' : 's'}
          </p>
          <div className="mcp-pg-grid">
            {filtered.map((s) => (
              <article
                key={s.id}
                className="mcp-pg-card"
                onClick={() => navigate(`/integrations/mcp/test/${encodeURIComponent(s.id)}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(`/integrations/mcp/test/${encodeURIComponent(s.id)}`);
                }}
              >
                <div className="mcp-pg-card-head">
                  <div className="mcp-pg-card-icon">{s.name?.charAt(0)?.toUpperCase() || 'M'}</div>
                  <div className="mcp-pg-card-badges">
                    <span className={`mcp-pg-status ${statusClass(s.status)}`}>{s.status}</span>
                    <span className="mcp-pg-transport">{transportLabel(s.transport)}</span>
                  </div>
                </div>
                <h3>{s.name}</h3>
                <p className="mcp-pg-card-desc">{s.description || 'No description'}</p>
                <code className="mcp-pg-card-url">{s.url}</code>
                <div className="mcp-pg-card-meta">
                  <span>{s.tool_count ?? 0} tools</span>
                  {s.is_shared && <span className="mcp-pg-tag platform">Platform</span>}
                  {s.is_mine && !s.is_shared && <span className="mcp-pg-tag mine">Yours</span>}
                  {s.server_info?.name && <span>{s.server_info.name}</span>}
                </div>
                {s.last_error && <p className="mcp-pg-card-error">{s.last_error}</p>}
                <div className="mcp-pg-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="mcp-pg-btn-primary mcp-pg-btn-sm"
                    onClick={() => navigate(`/integrations/mcp/test/${encodeURIComponent(s.id)}`)}
                  >
                    Test server
                  </button>
                  {s.can_delete && (
                    <button
                      type="button"
                      className="mcp-pg-btn-ghost mcp-pg-btn-sm mcp-pg-btn-danger"
                      disabled={deleting === s.id}
                      onClick={(e) => remove(s.id, e)}
                    >
                      {deleting === s.id ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!filtered.length && (
            <div className="mcp-pg-empty">
              <p>No MCP servers match your filters.</p>
              <button type="button" className="mcp-pg-btn-primary" onClick={() => setModalOpen(true)}>
                Register your first server
              </button>
            </div>
          )}
        </>
      )}

      {modalOpen && (
        <div className="mcp-pg-modal-backdrop" onClick={() => setModalOpen(false)}>
          <form
            className="mcp-pg-modal"
            onSubmit={register}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mcp-pg-modal-header">
              <h2>Register MCP server</h2>
              <button type="button" className="mcp-pg-btn-icon" onClick={() => setModalOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <p className="mcp-pg-hint">
              Auth tokens are not stored here. Provide them on the test screen or per workflow node.
            </p>
            <label className="mcp-pg-field">
              <span>Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="mcp-pg-field">
              <span>Description</span>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What does this MCP provide?"
              />
            </label>
            <label className="mcp-pg-field">
              <span>Remote server URL</span>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
                required
              />
            </label>
            <div className="mcp-pg-field">
              <span>Transport method</span>
              <div className="mcp-pg-segment">
                <button
                  type="button"
                  className={form.transport === 'streamable_http' ? 'active' : ''}
                  onClick={() => setForm({ ...form, transport: 'streamable_http' })}
                >
                  HTTP / Streamable
                  <small>Standard · Recommended</small>
                </button>
                <button
                  type="button"
                  className={form.transport === 'sse' ? 'active' : ''}
                  onClick={() => setForm({ ...form, transport: 'sse' })}
                >
                  SSE
                  <small>Server-Sent Events</small>
                </button>
              </div>
            </div>
            <div className="mcp-pg-modal-actions">
              <button type="button" className="mcp-pg-btn-ghost" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="mcp-pg-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Register'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
