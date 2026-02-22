import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

// Build hierarchy: CEO (me) → COO → delegated agents
function buildHierarchy(agents) {
  const coo = agents.find((a) => a.is_coo);
  const delegated = agents.filter((a) => a.parent_id && a.parent_id === (coo?.id ?? ''));
  return { ceo: { id: 'ceo', name: 'CEO (me)', role: 'You' }, coo, delegated };
}

// Voice: browser Speech Synthesis API (Edge/Chrome TTS)
function useEdgeTTS() {
  const [speaking, setSpeaking] = useState(false);
  const [voicesReady, setVoicesReady] = useState(false);

  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const loadVoices = () => {
      if (speechSynthesis.getVoices().length > 0) setVoicesReady(true);
    };
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
    return () => speechSynthesis.cancel();
  }, []);

  const speak = (text) => {
    if (!text?.trim()) return;
    const voices = speechSynthesis.getVoices();
    const professional = voices.find((v) => /Desktop|Online|Natural|Professional|Neural/i.test(v.name))
      || voices.find((v) => v.name.includes('Microsoft') || v.name.includes('Edge') || v.name.includes('Zira') || v.name.includes('David'));
    // Chunk long text so TTS doesn't drop or fail (many browsers limit utterance length)
    const chunks = text.match(/[^.!?]+[.!?]*/g) || [text.slice(0, 200)];
    let i = 0;
    const speakNext = () => {
      while (i < chunks.length && !chunks[i].trim()) i++;
      if (i >= chunks.length) {
        setSpeaking(false);
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[i].trim());
      if (professional) u.voice = professional;
      u.rate = 0.9;
      u.pitch = 1;
      if (i === 0) u.onstart = () => setSpeaking(true);
      u.onend = () => { i++; speakNext(); };
      u.onerror = () => { i++; speakNext(); };
      speechSynthesis.speak(u);
    };
    speechSynthesis.cancel();
    speakNext();
  };

  const stop = () => {
    speechSynthesis.cancel();
    setSpeaking(false);
  };

  return { speak, stop, speaking, voicesReady };
}

export default function Dashboard() {
  const [agents, setAgents] = useState([]);
  const [standups, setStandups] = useState([]);
  const [selectedStandup, setSelectedStandup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newParentId, setNewParentId] = useState('');
  const [creatingStandup, setCreatingStandup] = useState(false);
  const [standupScheduledAt, setStandupScheduledAt] = useState(() => {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [runningCoo, setRunningCoo] = useState(false);
  const [runningCronStandup, setRunningCronStandup] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [getWorkLoading, setGetWorkLoading] = useState(false);
  const [checkUpdatesLoading, setCheckUpdatesLoading] = useState(false);
  const [standupChatInput, setStandupChatInput] = useState('');
  const [deletingStandupId, setDeletingStandupId] = useState(null);
  const { speak, stop, speaking } = useEdgeTTS();

  const refreshStandup = () => {
    if (!selectedStandup?.id) return;
    api.standupGet(selectedStandup.id)
      .then((s) => {
        setSelectedStandup(s);
        setStandups((prev) => prev.map((x) => (x.id === s.id ? s : x)));
      })
      .catch(() => {});
  };

  const fetchData = () => {
    setLoading(true);
    setError(null);
    Promise.all([api.agentsList(), api.standupsList(20)])
      .then(([a, s]) => {
        setAgents(a);
        setStandups(s);
        if (s.length > 0 && !selectedStandup) setSelectedStandup(s[0]);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!selectedStandup?.id || selectedStandup.responses !== undefined) return;
    api.standupGet(selectedStandup.id).then(setSelectedStandup).catch(() => {});
  }, [selectedStandup?.id]);

  // Auto-refresh standup chat so delegated agent responses appear without clicking "Check for updates"
  const STANDUP_POLL_INTERVAL_MS = 6000;
  useEffect(() => {
    if (!selectedStandup?.id) return;
    const tick = () => {
      api.standupGet(selectedStandup.id)
        .then((s) => {
          setSelectedStandup((prev) => {
            if (!prev || prev.id !== s.id) return prev;
            const prevMsgCount = Array.isArray(prev.messages) ? prev.messages.length : 0;
            const nextMsgCount = Array.isArray(s.messages) ? s.messages.length : 0;
            if (nextMsgCount > prevMsgCount || JSON.stringify(prev.messages) !== JSON.stringify(s.messages))
              return s;
            return prev;
          });
          setStandups((prev) => prev.map((x) => (x.id === s.id ? s : x)));
        })
        .catch(() => {});
    };
    const id = setInterval(tick, STANDUP_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selectedStandup?.id]);

  const addAgent = (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const body = { name: newName.trim(), role: newRole.trim() || 'Agent' };
    if (newParentId) body.parent_id = newParentId;
    api.agentCreate(body)
      .then((agent) => {
        setAgents((prev) => [...prev, agent]);
        setNewName('');
        setNewRole('');
        setNewParentId('');
      })
      .catch((e) => setError(e.message));
  };

  const removeAgent = (agentId) => {
    if (!window.confirm('Remove this agent? This cannot be undone.')) return;
    api.agentDelete(agentId)
      .then(() => fetchData())
      .catch((e) => setError(e.message));
  };

  const createStandup = () => {
    setCreatingStandup(true);
    const scheduledAt = standupScheduledAt ? new Date(standupScheduledAt).toISOString() : new Date().toISOString();
    api.standupCreate({ scheduled_at: scheduledAt, status: 'scheduled' })
      .then((s) => {
        setStandups((prev) => [s, ...prev]);
        setSelectedStandup(s);
      })
      .catch((e) => setError(e.message))
      .finally(() => setCreatingStandup(false));
  };

  const deleteStandup = (id, e) => {
    e?.stopPropagation?.();
    if (!window.confirm('Delete this standup and its chat history? This cannot be undone.')) return;
    setDeletingStandupId(id);
    api.standupDelete(id)
      .then(() => {
        setStandups((prev) => {
          const next = prev.filter((s) => s.id !== id);
          if (selectedStandup?.id === id) setSelectedStandup(next[0] || null);
          return next;
        });
      })
      .catch((e) => setError(e.message))
      .finally(() => setDeletingStandupId(null));
  };

  const runCoo = () => {
    if (!selectedStandup) return;
    setRunningCoo(true);
    api.standupRunCoo(selectedStandup.id, false)
      .then((updated) => {
        setStandups((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        setSelectedStandup(updated);
      })
      .catch((e) => setError(e.message))
      .finally(() => setRunningCoo(false));
  };

  const runCronStandup = () => {
    setRunningCronStandup(true);
    setError(null);
    api.cronRunStandup()
      .then(({ standup }) => {
        if (standup) {
          setStandups((prev) => [standup, ...prev]);
          setSelectedStandup(standup);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setRunningCronStandup(false));
  };

  const handleStandupMessage = (e) => {
    e.preventDefault();
    if (!selectedStandup?.id || !standupChatInput.trim()) return;
    setSendingMessage(true);
    setError(null);
    api.standupSendMessage(selectedStandup.id, { content: standupChatInput.trim() })
      .then(() => {
        setStandupChatInput('');
        refreshStandup();
      })
      .catch((e) => setError(e.message))
      .finally(() => setSendingMessage(false));
  };

  const handleGetWorkFromTeam = () => {
    if (!selectedStandup?.id) return;
    setGetWorkLoading(true);
    setError(null);
    api.standupSendMessage(selectedStandup.id, { action: 'get_work_from_team' })
      .then(() => refreshStandup())
      .catch((e) => setError(e.message))
      .finally(() => setGetWorkLoading(false));
  };

  const handleCheckForUpdates = () => {
    setCheckUpdatesLoading(true);
    setError(null);
    api.cronProcessDelegations()
      .then(() => refreshStandup())
      .catch((e) => setError(e.message))
      .finally(() => setCheckUpdatesLoading(false));
  };

  const hierarchy = buildHierarchy(agents);

  if (loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (error) return <div style={{ padding: '2rem', color: '#f87171' }}>Error: {error}</div>;

  return (
    <div style={{ padding: '2rem', maxWidth: 960 }}>
      <h1 style={{ marginTop: 0 }}>Dashboard</h1>

      {/* Org chart: CEO → COO → delegated agents */}
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Org chart</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          CEO (you) → agents by role (from DB) → delegated agents. Click Chat to talk to an agent.
        </p>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {/* CEO row */}
          <div
            style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface)',
              fontWeight: 600,
            }}
          >
            <span style={{ color: 'var(--accent)' }}>👤 {hierarchy.ceo.name}</span>
            <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: '0.5rem' }}>— {hierarchy.ceo.role}</span>
          </div>
          {/* COO row — name and role from DB */}
          {hierarchy.coo && (
            <div
              style={{
                padding: '1rem 1.25rem',
                borderBottom: hierarchy.delegated.length ? '1px solid var(--border)' : 'none',
                paddingLeft: '2.5rem',
                background: 'var(--surface)',
              }}
            >
              <span style={{ fontWeight: 500 }}>{hierarchy.coo.name}</span>
              {hierarchy.coo.role && <span style={{ color: 'var(--muted)', marginLeft: '0.5rem' }}>({hierarchy.coo.role})</span>}
              <span style={{ marginLeft: '0.75rem' }}>
                <Link to={`/agents/${hierarchy.coo.id}/workspace`} style={{ marginRight: '0.5rem', fontSize: '0.9rem' }}>
                  Workspace
                </Link>
                <Link
                  to={`/agents/${hierarchy.coo.id}/chat`}
                  style={{
                    padding: '0.25rem 0.6rem',
                    background: 'var(--accent)',
                    color: '#fff',
                    borderRadius: 6,
                    fontSize: '0.9rem',
                  }}
                >
                  Chat
                </Link>
                <button
                  type="button"
                  onClick={() => removeAgent(hierarchy.coo.id)}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem 0.6rem',
                    background: 'transparent',
                    color: 'var(--muted)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                  }}
                >
                  Remove
                </button>
              </span>
            </div>
          )}
          {/* Delegated agents */}
          {hierarchy.delegated.length > 0 && (
            <div style={{ padding: '0.75rem 1.25rem', paddingLeft: '3.5rem', background: 'var(--surface)' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>Delegated agents</div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {hierarchy.delegated.map((a) => (
                  <li key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontWeight: 500 }}>{a.name}</span>
                    {a.role && <span style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>({a.role})</span>}
                    <Link to={`/agents/${a.id}/workspace`} style={{ fontSize: '0.85rem' }}>Workspace</Link>
                    <Link
                      to={`/agents/${a.id}/chat`}
                      style={{
                        padding: '0.2rem 0.5rem',
                        background: 'var(--accent)',
                        color: '#fff',
                        borderRadius: 6,
                        fontSize: '0.85rem',
                      }}
                    >
                      Chat
                    </Link>
                    <button
                      type="button"
                      onClick={() => removeAgent(a.id)}
                      style={{
                        padding: '0.2rem 0.5rem',
                        background: 'transparent',
                        color: 'var(--muted)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {agents.length === 0 && (
          <div style={{ marginTop: '0.75rem', padding: '1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <p style={{ color: 'var(--muted)', margin: '0 0 0.5rem' }}>No agents in the database.</p>
            <p style={{ fontSize: '0.9rem', color: 'var(--muted)', margin: 0 }}>
              Restart the backend — it will auto-seed default agents if the table is empty. Or run from backend: <code style={{ background: 'var(--surface)', padding: '1px 4px', borderRadius: 4 }}>node scripts/seed-all.js</code>
            </p>
            <button
              type="button"
              onClick={() => fetchData()}
              style={{ marginTop: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.9rem' }}
            >
              Refresh agents
            </button>
          </div>
        )}
      </section>

      {/* Standups — create or open a scheduled standup; COO chat opens and is specific to that standup. Child agent responses appear in this chat. */}
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Standups</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          Create or open a standup. In the chat, <strong>request AI and/or finance topics</strong> (e.g. &quot;Research AI trends and give me Q2 expense report&quot;). Multi-intent messages are split: the COO sends to both TechResearcher and ExpenseManager when both topics are present. Responses appear automatically; &quot;Check for updates&quot; processes any queued tasks immediately.
        </p>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 220, maxWidth: 300 }}>
            <div style={{ marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Scheduled standups</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.35rem' }}>
                <input
                  type="datetime-local"
                  value={standupScheduledAt}
                  onChange={(e) => setStandupScheduledAt(e.target.value)}
                  style={{ padding: '0.4rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: '0.9rem' }}
                />
                <button
                  type="button"
                  onClick={createStandup}
                  disabled={creatingStandup}
                  style={{ padding: '0.5rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: creatingStandup ? 'not-allowed' : 'pointer', fontSize: '0.9rem' }}
                >
                  {creatingStandup ? 'Creating…' : 'Create standup'}
                </button>
              </div>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              {standups.slice(0, 12).map((s) => (
                <li
                  key={s.id}
                  onClick={() => setSelectedStandup(s)}
                  style={{
                    padding: '0.6rem 0.75rem',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    background: selectedStandup?.id === s.id ? 'var(--accent)' : 'var(--surface)',
                    color: selectedStandup?.id === s.id ? '#fff' : 'var(--text)',
                    fontSize: '0.9rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {new Date(s.scheduled_at).toLocaleString()} — {s.status}
                    {s.source === 'cron' && <span style={{ opacity: 0.9, fontSize: '0.8rem' }}> (auto)</span>}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => deleteStandup(s.id, e)}
                    disabled={deletingStandupId === s.id}
                    title="Delete standup"
                    style={{
                      padding: '0.2rem 0.4rem',
                      background: 'transparent',
                      border: '1px solid currentColor',
                      borderRadius: 4,
                      cursor: deletingStandupId === s.id ? 'not-allowed' : 'pointer',
                      opacity: deletingStandupId === s.id ? 0.6 : 0.9,
                      fontSize: '0.75rem',
                    }}
                  >
                    {deletingStandupId === s.id ? '…' : 'Delete'}
                  </button>
                </li>
              ))}
            </ul>
            {standups.length === 0 && (
              <p style={{ color: 'var(--muted)', padding: '0.75rem', margin: 0, fontSize: '0.9rem' }}>No standups. Create one above.</p>
            )}
          </div>
          <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {selectedStandup ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <strong style={{ fontSize: '1rem' }}>
                    COO chat — {new Date(selectedStandup.scheduled_at).toLocaleString()}
                  </strong>
                  <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={handleGetWorkFromTeam}
                      disabled={getWorkLoading}
                      style={{ padding: '0.4rem 0.75rem', background: getWorkLoading ? 'var(--muted)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: getWorkLoading ? 'not-allowed' : 'pointer', fontSize: '0.85rem' }}
                    >
                      {getWorkLoading ? '…' : 'Get work from team'}
                    </button>
                    <button
                      type="button"
                      onClick={handleCheckForUpdates}
                      disabled={checkUpdatesLoading}
                      style={{ padding: '0.4rem 0.75rem', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: checkUpdatesLoading ? 'not-allowed' : 'pointer', fontSize: '0.85rem' }}
                    >
                      {checkUpdatesLoading ? '…' : 'Check for updates'}
                    </button>
                  </span>
                </div>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem', minHeight: 280, maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {Array.isArray(selectedStandup.messages) && selectedStandup.messages.length > 0 ? (
                    selectedStandup.messages.map((m) => (
                      <div key={m.id}>
                        <span style={{ fontWeight: 600, color: m.role === 'coo' ? 'var(--accent)' : 'var(--text)', fontSize: '0.9rem' }}>{m.role === 'coo' ? 'COO' : 'You'}:</span>
                        <p style={{ whiteSpace: 'pre-wrap', margin: '0.2rem 0 0', fontSize: '0.95rem' }}>{m.content}</p>
                      </div>
                    ))
                  ) : (
                    <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.9rem' }}>No messages yet. Send the day&apos;s tasks to the COO below.</p>
                  )}
                </div>
                <form onSubmit={handleStandupMessage} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                  <textarea
                    rows={3}
                    value={standupChatInput}
                    onChange={(e) => setStandupChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (standupChatInput.trim()) handleStandupMessage(e);
                      }
                    }}
                    placeholder="Request AI or finance topics (e.g. research on X, expense summary for Y). Multi-intent: e.g. research AI trends and give me Q2 expense report."
                    style={{ flex: 1, padding: '0.5rem 0.75rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', resize: 'vertical', minHeight: 56, font: 'inherit' }}
                  />
                  <button type="submit" disabled={sendingMessage || !standupChatInput.trim()} style={{ padding: '0.5rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: sendingMessage ? 'not-allowed' : 'pointer' }}>
                    {sendingMessage ? 'Sending…' : 'Send'}
                  </button>
                </form>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                  <button type="button" onClick={runCoo} disabled={runningCoo} style={{ padding: '0.35rem 0.75rem', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: runningCoo ? 'not-allowed' : 'pointer', fontSize: '0.85rem' }}>{runningCoo ? '…' : 'Run COO summary'}</button>
                  <button type="button" onClick={() => speak([selectedStandup.coo_summary, selectedStandup.ceo_summary].filter(Boolean).join('\n\n'))} disabled={speaking || (!selectedStandup.coo_summary && !selectedStandup.ceo_summary)} style={{ padding: '0.35rem 0.75rem', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}>Listen</button>
                </div>
                {(selectedStandup.coo_summary || selectedStandup.ceo_summary) && (
                  <details style={{ marginTop: '0.25rem', fontSize: '0.9rem' }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>Summary</summary>
                    <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
                      {selectedStandup.coo_summary && <p style={{ margin: '0 0 0.5rem' }}><strong>COO:</strong> {selectedStandup.coo_summary}</p>}
                      {selectedStandup.ceo_summary && <p style={{ margin: 0 }}><strong>CEO:</strong> {selectedStandup.ceo_summary}</p>}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                Create a standup or select one from the list to open the COO chat for that schedule.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Add agent (optional) */}
      <section>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Add agent</h2>
        <form onSubmit={addAgent} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Agent name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{
              padding: '0.5rem 0.75rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              minWidth: 160,
            }}
          />
          <input
            type="text"
            placeholder="Role (optional)"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            style={{
              padding: '0.5rem 0.75rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              minWidth: 120,
            }}
          />
          <select
            value={newParentId}
            onChange={(e) => setNewParentId(e.target.value)}
            style={{
              padding: '0.5rem 0.75rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--text)',
              minWidth: 140,
            }}
          >
            <option value="">Report to (optional)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.is_coo ? ' (COO)' : ''}</option>
            ))}
          </select>
          <button
            type="submit"
            style={{
              padding: '0.5rem 1rem',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              color: '#fff',
            }}
          >
            Add agent
          </button>
        </form>
      </section>
    </div>
  );
}
