import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';

const FILE_NAMES = ['soul', 'agents', 'memory'];

export default function AgentWorkspace() {
  const { agentId } = useParams();
  const [agent, setAgent] = useState(null);
  const [files, setFiles] = useState({ files: [], daily: [] });
  const [selected, setSelected] = useState('soul');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.agentGet(agentId)
      .then(setAgent)
      .catch((e) => setError(e.message));
  }, [agentId]);

  useEffect(() => {
    if (!agentId) return;
    api.agentWorkspaceFiles(agentId)
      .then((r) => setFiles(r))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => {
    if (!agentId || !selected) return;
    setLoading(true);
    api.agentWorkspaceRead(agentId, selected)
      .then((r) => setContent(r.text ?? ''))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId, selected]);

  const save = () => {
    setSaving(true);
    api.agentWorkspaceWrite(agentId, selected, content)
      .then(() => setSaving(false))
      .catch((e) => {
        setError(e.message);
        setSaving(false);
      });
  };

  if (error && !agent) return <div style={{ padding: '2rem', color: '#f87171' }}>Error: {error}. <Link to="/">Dashboard</Link></div>;

  const tabs = [...(files.files || []).map((f) => f.name), ...(files.daily || []).map((f) => `memory/${f.name}`)];
  const activeTabs = tabs.length ? tabs : FILE_NAMES;

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '1rem' }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>← Dashboard</Link>
        <Link to="/workspace" style={{ color: 'var(--muted)', fontSize: '0.9rem', marginLeft: '1rem' }}>All agents</Link>
      </div>
      <h1 style={{ marginTop: 0 }}>Workspace — {agent?.name || agentId}</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
        Edit SOUL.md, AGENTS.md, MEMORY.md for this agent’s OpenClaw workspace. Backups are created on save.
        {agent && !agent.workspace_path && ' (Using default workspace; set workspace_path on this agent for a separate folder.)'}
      </p>

      {error && <div style={{ padding: '0.5rem 1rem', background: 'rgba(248,113,113,0.15)', borderRadius: 8, marginBottom: '1rem', color: '#f87171' }}>{error}</div>}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {activeTabs.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setSelected(name)}
            style={{
              padding: '0.5rem 1rem',
              background: selected === name ? 'var(--accent)' : 'var(--surface)',
              border: `1px solid ${selected === name ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 6,
              color: selected === name ? '#fff' : 'var(--text)',
            }}
          >
            {name}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 400 }}>
        {loading ? (
          <div>Loading…</div>
        ) : (
          <>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{
                flex: 1,
                minHeight: 360,
                padding: '1rem',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text)',
                fontFamily: 'ui-monospace, monospace',
                fontSize: '0.9rem',
                resize: 'vertical',
              }}
              spellCheck={false}
            />
            <button
              type="button"
              onClick={save}
              disabled={saving}
              style={{
                marginTop: '0.75rem',
                padding: '0.5rem 1.25rem',
                background: saving ? 'var(--muted)' : 'var(--accent)',
                border: 'none',
                borderRadius: 6,
                color: '#fff',
                alignSelf: 'flex-start',
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
