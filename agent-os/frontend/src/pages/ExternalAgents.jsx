import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import MaskedSecretInput from '../components/MaskedSecretInput';

const EMPTY_FORM = {
  name: '',
  description: '',
  card_url: '',
  endpoint_url: '',
  skill_id: '',
  auth_header: '',
};

export default function ExternalAgents() {
  const { user } = useAuth();
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [testMessage, setTestMessage] = useState('Hello from Agent OS');
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .externalAgentsList()
      .then((r) => setAgents(r.agents || []))
      .catch((e) => {
        setError(e.message);
        setAgents([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const register = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.externalAgentCreate(form);
      setModalOpen(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const discover = async (id) => {
    setBusy(`discover-${id}`);
    setError(null);
    try {
      await api.externalAgentDiscover(id);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this external agent?')) return;
    setBusy(`del-${id}`);
    try {
      await api.externalAgentDelete(id);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const testInvoke = async (id) => {
    setBusy(`test-${id}`);
    setTestResult(null);
    setError(null);
    try {
      const out = await api.externalAgentInvoke(id, { message: testMessage });
      setTestResult(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page" style={{ padding: '1.5rem', maxWidth: 960 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.85rem' }}>Integrations · A2A</p>
          <h1 style={{ margin: '0.25rem 0 0' }}>External Agents</h1>
          <p style={{ color: 'var(--muted)', marginTop: '0.5rem' }}>
            Register third-party agents that speak the{' '}
            <a href="https://a2a-protocol.org/" target="_blank" rel="noreferrer">
              A2A protocol
            </a>
            . Discover their agent card, then use them in workflow <strong>External Agent (A2A)</strong> nodes.
            {user?.role === 'admin' ? ' Admin registrations can be shared platform-wide.' : ''}
          </p>
        </div>
        <button type="button" className="wf-btn-primary" onClick={() => setModalOpen(true)}>
          + Register agent
        </button>
      </header>

      {error && (
        <div style={{ padding: '0.75rem 1rem', background: 'rgba(248,113,113,0.12)', borderRadius: 8, marginBottom: '1rem', color: '#f87171' }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : !agents.length ? (
        <p style={{ color: 'var(--muted)' }}>No external agents registered yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {agents.map((a) => (
            <div key={a.id} className="wf-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <strong>{a.name}</strong>
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: '0.7rem',
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: a.status === 'healthy' ? 'rgba(22,163,74,0.15)' : 'rgba(163,163,163,0.2)',
                      color: a.status === 'healthy' ? '#16a34a' : 'var(--muted)',
                    }}
                  >
                    {a.status}
                  </span>
                  <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 4 }}>{a.description || '—'}</div>
                  <code style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{a.id}</code>
                  {a.endpoint_url && (
                    <div style={{ fontSize: '0.8rem', marginTop: 4, wordBreak: 'break-all' }}>
                      Endpoint: {a.endpoint_url}
                    </div>
                  )}
                  {a.agent_card?.skills?.length > 0 && (
                    <div style={{ fontSize: '0.8rem', marginTop: 4 }}>
                      Skills: {a.agent_card.skills.map((s) => s.name || s.id).filter(Boolean).join(', ')}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <button type="button" className="wf-btn" disabled={!!busy} onClick={() => discover(a.id)}>
                    {busy === `discover-${a.id}` ? 'Discovering…' : 'Discover'}
                  </button>
                  <button type="button" className="wf-btn wf-btn-danger" disabled={!!busy || !a.can_delete} onClick={() => remove(a.id)}>
                    Delete
                  </button>
                </div>
              </div>
              {a.status === 'healthy' && (
                <div style={{ marginTop: '0.75rem', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    value={testMessage}
                    onChange={(e) => setTestMessage(e.target.value)}
                    style={{ flex: 1, minWidth: 200, padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)' }}
                    placeholder="Test message"
                  />
                  <button type="button" className="wf-btn-accent" disabled={!!busy} onClick={() => testInvoke(a.id)}>
                    {busy === `test-${a.id}` ? 'Sending…' : 'Test A2A invoke'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {testResult && (
        <div className="wf-card" style={{ marginTop: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>Last test result</h3>
          <pre style={{ fontSize: '0.8rem', overflow: 'auto', maxHeight: 240 }}>{JSON.stringify(testResult, null, 2)}</pre>
        </div>
      )}

      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
        Use registered agents in the <Link to="/workflows">Workflow editor</Link> → add <strong>External Agent (A2A)</strong> node.
      </p>

      {modalOpen && (
        <div
          role="dialog"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
          onClick={() => setModalOpen(false)}
        >
          <form
            className="wf-card"
            style={{ width: '100%', maxWidth: 480 }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={register}
          >
            <h2 style={{ marginTop: 0 }}>Register external agent</h2>
            <label className="wf-field">
              Name
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="wf-field">
              Description
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <label className="wf-field">
              Agent card URL (base or full)
              <input
                value={form.card_url}
                onChange={(e) => setForm({ ...form, card_url: e.target.value })}
                placeholder="https://hello-world-gxfr.onrender.com"
              />
              <small>
                Base URL or full path — tries /.well-known/agent-card.json then /.well-known/agent.json (Hello World uses
                agent.json)
              </small>
            </label>
            <label className="wf-field">
              A2A endpoint URL (optional if in card)
              <input
                value={form.endpoint_url}
                onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })}
                placeholder="https://agent.example.com/"
              />
              <small>JSON-RPC service root — not the agent.json card URL</small>
            </label>
            <label className="wf-field">
              Default skill ID
              <input value={form.skill_id} onChange={(e) => setForm({ ...form, skill_id: e.target.value })} />
            </label>
            <label className="wf-field">
              Auth (Bearer token)
              <MaskedSecretInput
                value={form.auth_header}
                onChange={(e) => setForm({ ...form, auth_header: e.target.value })}
                placeholder="optional"
              />
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: '1rem' }}>
              <button type="submit" className="wf-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Register'}
              </button>
              <button type="button" className="wf-btn" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
