import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import ChatMessageContent from './ChatMessageContent';
import { useAuth } from '../context/AuthContext';

/**
 * Embeddable chat panel for an OpenClaw agent.
 * @param {string} agentId - e.g. jobdiscovery
 * @param {string} [profileId] - job search profile context
 * @param {string} [placeholder] - input placeholder
 * @param {number} [minHeight] - scroll panel min height px
 */
export default function AgentChatPanel({
  agentId,
  profileId = null,
  placeholder = 'Message…',
  minHeight = 280,
  quickActions = [],
}) {
  const { dataCeoUserId } = useAuth();
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

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

  const sendMessage = (msg) => {
    const text = String(msg || '').trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setTurns((prev) => [...prev, { role: 'user', content: text, created_at: new Date().toISOString() }]);
    return api
      .agentChatSend(agentId, text, dataCeoUserId || 'default', profileId)
      .then((r) => {
        setTurns((prev) => [...prev, { role: 'assistant', content: r.reply, created_at: new Date().toISOString() }]);
      })
      .catch((e) => {
        setError(e.message);
        setTurns((prev) => prev.filter((t) => t.role !== 'user' || t.content !== text));
      })
      .finally(() => setSending(false));
  };

  const send = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    const msg = input.trim();
    setInput('');
    sendMessage(msg);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight }}>
      {error && (
        <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(248,113,113,0.15)', borderRadius: 6, marginBottom: '0.5rem', color: '#f87171', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight,
          maxHeight: 420,
          overflowY: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '0.75rem',
          marginBottom: '0.5rem',
        }}
      >
        {turns.length === 0 && !sending && (
          <div style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            Chat with Job Discovery to create or refine profiles. Profile context is sent automatically when selected.
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            style={{
              marginBottom: '0.75rem',
              padding: '0.5rem 0.75rem',
              background: t.role === 'user' ? 'var(--border)' : 'transparent',
              borderRadius: 6,
              borderLeft: t.role === 'assistant' ? '3px solid var(--accent)' : 'none',
            }}
          >
            <span style={{ fontSize: '0.7rem', color: 'var(--muted)', marginRight: '0.5rem' }}>{t.role}</span>
            <ChatMessageContent content={t.content} />
          </div>
        ))}
        {sending && <div style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>…</div>}
      </div>
      {quickActions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          {quickActions.map((qa) => (
            <button
              key={qa.label}
              type="button"
              disabled={sending}
              onClick={() => sendMessage(qa.message)}
              style={{
                padding: '0.35rem 0.65rem',
                fontSize: '0.8rem',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                cursor: sending ? 'not-allowed' : 'pointer',
              }}
            >
              {qa.label}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={send} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
          style={{
            flex: 1,
            padding: '0.6rem 0.75rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text)',
          }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          style={{
            padding: '0.6rem 1rem',
            background: sending || !input.trim() ? 'var(--border)' : 'var(--accent)',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
