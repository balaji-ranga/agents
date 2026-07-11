import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';

const FILE_NAMES = ['soul', 'agents', 'memory', 'tools'];
const TOOLS_TAB = '__tool_access__';

export default function AgentWorkspace() {
  const { agentId } = useParams();
  const [agent, setAgent] = useState(null);
  const [files, setFiles] = useState({ files: [], daily: [] });
  const [selected, setSelected] = useState('soul');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearingSessions, setClearingSessions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toolCatalog, setToolCatalog] = useState([]);
  const [toolGrants, setToolGrants] = useState(new Set());
  const [toolsSaving, setToolsSaving] = useState(false);
  const [syncingMd, setSyncingMd] = useState(false);

  const clearSessions = () => {
    if (!window.confirm('Clear all OpenClaw sessions for this agent? Chat and task session history will be reset.')) return;
    setClearingSessions(true);
    setError(null);
    api.agentSessionsClear(agentId)
      .then(() => setError(null))
      .catch((e) => setError(e.message))
      .finally(() => setClearingSessions(false));
  };

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
    if (!agentId) return;
    api.agentToolsGet(agentId)
      .then((r) => {
        setToolCatalog(r.tools || []);
        setToolGrants(new Set((r.grants || []).map(String)));
      })
      .catch((e) => setError(e.message));
  }, [agentId]);

  useEffect(() => {
    if (!agentId || !selected || selected === TOOLS_TAB) return;
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

  const toggleTool = (name) => {
    setToolGrants((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const saveTools = () => {
    setToolsSaving(true);
    setError(null);
    api.agentToolsSet(agentId, [...toolGrants])
      .then((r) => {
        setToolCatalog(r.tools || []);
        setToolGrants(new Set((r.grants || []).map(String)));
      })
      .catch((e) => setError(e.message))
      .finally(() => setToolsSaving(false));
  };

  const syncTemplateMd = () => {
    setSyncingMd(true);
    setError(null);
    api.agentToolsSyncTemplateMd(agentId)
      .then(() => {
        if (selected === 'tools') {
          return api.agentWorkspaceRead(agentId, 'tools').then((r) => setContent(r.text ?? ''));
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setSyncingMd(false));
  };

  if (error && !agent) return <div style={{ padding: '2rem', color: '#f87171' }}>Error: {error}. <Link to="/">Dashboard</Link></div>;

  const tabs = [...(files.files || []).map((f) => f.name), ...(files.daily || []).map((f) => `memory/${f.name}`)];
  const activeTabs = tabs.length ? tabs : FILE_NAMES;
  const showToolsPanel = selected === TOOLS_TAB;

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ marginBottom: '1rem' }}>
        <Link to="/" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>← Dashboard</Link>
        <Link to="/workspace" style={{ color: 'var(--muted)', fontSize: '0.9rem', marginLeft: '1rem' }}>All agents</Link>
      </div>
      <h1 style={{ marginTop: 0 }}>Workspace — {agent?.name || agentId}</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
        Edit workspace files and manage which Agent OS tools this agent can invoke. MD file saves write directly to OpenClaw workspace files and are picked up on the next agent message (bootstrap watcher). Tool access changes apply immediately without restart.
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
        <button
          type="button"
          onClick={() => setSelected(TOOLS_TAB)}
          style={{
            padding: '0.5rem 1rem',
            background: showToolsPanel ? 'var(--accent)' : 'var(--surface)',
            border: `1px solid ${showToolsPanel ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 6,
            color: showToolsPanel ? '#fff' : 'var(--text)',
          }}
        >
          Tool access
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 400 }}>
        {showToolsPanel ? (
          <>
            <p style={{ color: 'var(--muted)', marginTop: 0 }}>
              Grant or revoke Agent OS content tools for <strong>{agent?.name || agentId}</strong>.
              Changes write to <code>~/.openclaw/agent-tool-allowlists.json</code> and sync <code>openclaw.json</code>.
            </p>
            <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem', background: 'var(--surface)' }}>
              {toolCatalog.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>No content tools registered.</p>
              ) : (
                toolCatalog.map((t) => (
                  <label
                    key={t.name}
                    style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={toolGrants.has(t.name)}
                      onChange={() => toggleTool(t.name)}
                      style={{ marginTop: 4 }}
                    />
                    <span>
                      <strong>{t.display_name || t.name}</strong>
                      <code style={{ marginLeft: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{t.name}</code>
                      {t.purpose && <div style={{ fontSize: '0.9rem', color: 'var(--muted)', marginTop: 4 }}>{t.purpose}</div>}
                    </span>
                  </label>
                ))
              )}
            </div>
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={saveTools}
                disabled={toolsSaving}
                style={{
                  padding: '0.5rem 1.25rem',
                  background: toolsSaving ? 'var(--muted)' : 'var(--accent)',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                }}
              >
                {toolsSaving ? 'Saving…' : 'Save tool access'}
              </button>
              <button
                type="button"
                onClick={syncTemplateMd}
                disabled={syncingMd}
                title="Copy TOOLS.md from workspace template (e.g. balserve) into this agent's workspace"
                style={{
                  padding: '0.5rem 1.25rem',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--text)',
                }}
              >
                {syncingMd ? 'Syncing…' : 'Sync TOOLS.md from template'}
              </button>
            </div>
          </>
        ) : loading ? (
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
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                style={{
                  padding: '0.5rem 1.25rem',
                  background: saving ? 'var(--muted)' : 'var(--accent)',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={clearSessions}
                disabled={clearingSessions}
                title="Clear OpenClaw session history for this agent"
                style={{
                  padding: '0.5rem 1.25rem',
                  background: clearingSessions ? 'var(--muted)' : 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--text)',
                }}
              >
                {clearingSessions ? 'Clearing…' : 'Clear sessions'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
