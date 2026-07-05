import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Workspace() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [clearingAgentId, setClearingAgentId] = useState(null);

  const clearSessions = (agentId) => {
    if (!window.confirm('Clear all OpenClaw sessions for this agent? Chat and task session history will be reset.')) return;
    setClearingAgentId(agentId);
    api.agentSessionsClear(agentId)
      .then(() => setError(null))
      .catch((e) => setError(e.message))
      .finally(() => setClearingAgentId(null));
  };

  const fetchAgents = () => {
    setLoading(true);
    api.agentsList()
      .then(setAgents)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const removeAgent = (agentId) => {
    if (!window.confirm('Remove this agent? This cannot be undone.')) return;
    api.agentDelete(agentId)
      .then(() => fetchAgents())
      .catch((e) => setError(e.message));
  };

  if (error) return <div style={{ padding: '2rem', color: '#f87171' }}>Error: {error}. <Link to="/">Dashboard</Link></div>;
  if (loading) return <div style={{ padding: '2rem' }}>Loading agents…</div>;

  return (
    <div style={{ padding: '2rem' }}>
      <h1 style={{ marginTop: 0 }}>Workspace (MD files)</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem' }}>
        MD file view/edit is per agent. Select an agent to open its SOUL.md, AGENTS.md, and MEMORY.md.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {agents.map((a) => (
          <li
            key={a.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '0.75rem 1rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              marginBottom: '0.5rem',
            }}
          >
            <span style={{ fontWeight: 500 }}>{a.name}</span>
            {a.role && <span style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{a.role}</span>}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
              <Link
                to={`/agents/${a.id}/workspace`}
                style={{
                  padding: '0.35rem 0.75rem',
                  background: 'var(--accent)',
                  color: '#fff',
                  borderRadius: 6,
                  fontSize: '0.9rem',
                }}
              >
                Open workspace
              </Link>
              <Link
                to={`/agents/${a.id}/chat`}
                style={{
                  padding: '0.35rem 0.75rem',
                  background: 'var(--border)',
                  color: 'var(--text)',
                  borderRadius: 6,
                  fontSize: '0.9rem',
                }}
              >
                Chat
              </Link>
              <button
                type="button"
                onClick={() => clearSessions(a.id)}
                disabled={clearingAgentId === a.id}
                title="Clear OpenClaw sessions for this agent"
                style={{
                  padding: '0.35rem 0.75rem',
                  background: 'transparent',
                  color: 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                }}
              >
                {clearingAgentId === a.id ? 'Clearing…' : 'Clear sessions'}
              </button>
              <button
                type="button"
                onClick={() => removeAgent(a.id)}
                style={{
                  padding: '0.35rem 0.75rem',
                  background: 'transparent',
                  color: 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                }}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      {agents.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>No agents yet. Add one from the Dashboard.</p>
      )}
    </div>
  );
}
