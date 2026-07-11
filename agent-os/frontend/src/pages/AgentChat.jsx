import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import ChatMessageRow from '../components/ChatMessageRow';

export default function AgentChat() {
  const { agentId } = useParams();
  const [searchParams] = useSearchParams();
  const profileId = searchParams.get('profile_id') || null;
  const { dataCeoUserId } = useAuth();
  const [agent, setAgent] = useState(null);
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.agentGet(agentId)
      .then(setAgent)
      .catch((e) => setError(e.message));
  }, [agentId]);

  useEffect(() => {
    if (!agentId) return;
    api.agentChatHistory(agentId)
      .then(setTurns)
      .catch(() => setTurns([]));
  }, [agentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, sending]);

  const send = (e) => {
    e.preventDefault();
    if (!input.trim() || sending) return;
    const msg = input.trim();
    setInput('');
    setSending(true);
    setError(null);
    setTurns((prev) => [...prev, { role: 'user', content: msg, created_at: new Date().toISOString() }]);
    api.agentChatSend(agentId, msg, dataCeoUserId || 'default', profileId)
      .then((r) => {
        setTurns((prev) => [...prev, { role: 'assistant', content: r.reply, created_at: new Date().toISOString() }]);
      })
      .catch((e) => {
        setError(e.message);
        setTurns((prev) => prev.filter((t) => t.role !== 'user' || t.content !== msg));
      })
      .finally(() => setSending(false));
  };

  if (error && !agent) return <div style={{ padding: '2rem', color: '#f87171' }}>Error: {error}. <Link to="/">Back to Dashboard</Link></div>;

  return (
    <div className="page-chat" style={{ padding: '2rem', maxWidth: 800, margin: '0 auto', width: '100%' }}>
      <div style={{ flexShrink: 0, marginBottom: '1rem' }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>← Dashboard</Link>
        <h1 style={{ margin: '0.5rem 0 0 0' }}>{agent?.name || agentId} — Chat</h1>
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          Human–agent interaction via OpenClaw gateway.
          {profileId && <> Profile context: <code>{profileId}</code></>}
        </p>
      </div>

      {error && (
        <div style={{ flexShrink: 0, padding: '0.5rem 1rem', background: 'rgba(248,113,113,0.15)', borderRadius: 8, marginBottom: '1rem', color: '#f87171' }}>
          {error}
        </div>
      )}

      <div
        ref={scrollRef}
        className="chat-scroll-panel"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '1rem',
          marginBottom: '1rem',
        }}
      >
        {turns.length === 0 && !sending && <div style={{ color: 'var(--muted)' }}>No messages yet. Send a message below.</div>}
        {turns.map((t, i) => (
          <ChatMessageRow key={i} role={t.role} content={t.content} createdAt={t.created_at} />
        ))}
        {sending && <div style={{ color: 'var(--muted)' }}>…</div>}
      </div>

      <form onSubmit={send} style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            placeholder="Message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending}
            style={{
              flex: 1,
              padding: '0.75rem 1rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              color: 'var(--text)',
            }}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            style={{
              padding: '0.75rem 1.25rem',
              background: (sending || !input.trim()) ? 'var(--border)' : 'var(--accent)',
              border: 'none',
              borderRadius: 8,
              color: '#fff',
            }}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
