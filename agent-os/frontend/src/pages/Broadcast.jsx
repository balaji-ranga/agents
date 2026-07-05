import { useState, useEffect } from 'react';
import { api } from '../api';
import ChatMessageContent from '../components/ChatMessageContent';

export default function Broadcast() {
  const [agents, setAgents] = useState([]);
  const [message, setMessage] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .agentsList()
      .then(setAgents)
      .catch((e) => setError(e.message));
  }, []);

  const sendAll = selectedIds.size === 0 || selectedIds.size === agents.length;
  const agentIds = sendAll ? null : Array.from(selectedIds);

  const handleSend = () => {
    if (!message.trim()) {
      setError('Enter a message');
      return;
    }
    setError(null);
    setResults(null);
    setLoading(true);
    api
      .broadcastSend(message.trim(), agentIds)
      .then((data) => setResults(data.results || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const toggleAgent = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(agents.map((a) => a.id)));
  const selectNone = () => setSelectedIds(new Set());

  return (
    <div style={{ padding: '1.5rem', maxWidth: 900 }}>
      <h1 style={{ marginTop: 0, marginBottom: '1rem' }}>Broadcast to agents</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
        Send a message to all or selected agents and see their replies in line. Requires the OpenClaw gateway to be running.
      </p>

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>Message</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="e.g. What is your current status?"
          rows={3}
          style={{
            width: '100%',
            padding: '0.5rem',
            border: '1px solid var(--border)',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: '0.95rem',
          }}
        />
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <span style={{ fontWeight: 500 }}>Agents</span>
          <button type="button" onClick={selectAll} style={{ fontSize: '0.85rem', padding: '0.2rem 0.5rem' }}>
            All
          </button>
          <button type="button" onClick={selectNone} style={{ fontSize: '0.85rem', padding: '0.2rem 0.5rem' }}>
            None
          </button>
          <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
            {selectedIds.size === 0 || selectedIds.size === agents.length ? 'All agents' : `${selectedIds.size} selected`}
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {agents.map((a) => (
            <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selectedIds.size === 0 || selectedIds.has(a.id)}
                onChange={() => toggleAgent(a.id)}
              />
              <span>{a.name || a.id}</span>
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: '1rem', padding: '0.5rem', background: 'var(--surface)', color: 'var(--error)', borderRadius: 6 }}>
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleSend}
        disabled={loading || agents.length === 0}
        style={{
          padding: '0.5rem 1rem',
          background: 'var(--accent)',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: loading ? 'not-allowed' : 'pointer',
          fontWeight: 500,
        }}
      >
        {loading ? 'Sending…' : 'Send to agents'}
      </button>

      {results && results.length > 0 && (
        <div style={{ marginTop: '1.5rem', maxHeight: 'min(60vh, 520px)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem', flexShrink: 0 }}>Responses</h2>
          <div className="chat-scroll-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {results.map((r) => (
              <div
                key={r.agent_id}
                style={{
                  padding: '1rem',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--surface)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--accent)' }}>
                  {r.name || r.agent_id}
                </div>
                {r.error ? (
                  <div style={{ color: 'var(--error)', fontSize: '0.9rem' }}>{r.error}</div>
                ) : (
                  <ChatMessageContent content={r.reply || '—'} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {results && results.length === 0 && !loading && (
        <p style={{ marginTop: '1rem', color: 'var(--muted)' }}>No agents to broadcast to.</p>
      )}
    </div>
  );
}
