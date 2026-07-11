import { useMemo, useState } from 'react';
import HttpHeadersEditor from '../HttpHeadersEditor.jsx';
import {
  parseMcpServerAuthMap,
  removeServerFromAuth,
  serverAuthHasHeaders,
  setServerAuthHeaders,
} from '../../utils/brainMcpConfigUtils.js';

function toolAllowlistForServer(allowlist, serverId) {
  return (allowlist || []).filter((k) => k.startsWith(`${serverId}::`));
}

function toggleToolInAllowlist(allowlist, serverId, toolName, checked) {
  const key = `${serverId}::${toolName}`;
  const base = (allowlist || []).filter((k) => !k.startsWith(`${serverId}::`));
  const serverKeys = (allowlist || []).filter((k) => k.startsWith(`${serverId}::`));
  const nextServerKeys = checked ? serverKeys.filter((k) => k !== key) : [...serverKeys, key];
  return [...base, ...nextServerKeys];
}

function ServerConfigModal({ server, serverId, allowlist, authHeadersJson, onAuthChange, onAllowlistChange, onClose }) {
  const selectedTools = toolAllowlistForServer(allowlist, serverId);
  const restrictTools = selectedTools.length > 0;

  return (
    <div className="mcp-pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="mcp-pg-modal wf-brain-mcp-modal"
        role="dialog"
        aria-labelledby="brain-mcp-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mcp-pg-modal-header">
          <div>
            <h2 id="brain-mcp-modal-title">{server.name}</h2>
            <p className="wf-brain-mcp-modal-sub">
              {server.id}
              {server.is_shared ? ' · platform' : ''} · {server.tools?.length ?? 0} tools
            </p>
          </div>
          <button type="button" className="wf-agent-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <section className="wf-brain-mcp-modal-section">
          <h3>Auth headers</h3>
          <p className="mcp-pg-hint">Used only when the Brain calls tools on this MCP server.</p>
          <HttpHeadersEditor value={authHeadersJson || '{}'} onChange={onAuthChange} />
        </section>

        <section className="wf-brain-mcp-modal-section">
          <h3>Tools exposed to the LLM</h3>
          <p className="mcp-pg-hint">
            {restrictTools
              ? `${selectedTools.length} tool(s) selected for this server.`
              : 'All tools on this server are exposed (check specific tools to restrict).'}
          </p>
          <div className="wf-brain-mcp-tool-list">
            {(server.tools || []).map((t) => {
              const key = `${serverId}::${t.name}`;
              const toolChecked = (allowlist || []).includes(key);
              return (
                <label key={key} className="wf-brain-mcp-tool-row">
                  <input
                    type="checkbox"
                    checked={toolChecked}
                    onChange={() => onAllowlistChange(toggleToolInAllowlist(allowlist, serverId, t.name, toolChecked))}
                  />
                  <span>
                    <strong>{t.name}</strong>
                    {t.description ? <small>{t.description}</small> : null}
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <div className="mcp-pg-modal-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Brain node: MCP server picker with per-server auth + tool allowlist (modal per server).
 */
export default function BrainMcpToolCallingPanel({ taskConfig, mcpServers, mcpLoadError, onTaskConfigChange }) {
  const [modalServerId, setModalServerId] = useState(null);

  const serverIds = Array.isArray(taskConfig?.mcpServerIds) ? taskConfig.mcpServerIds : [];
  const allowlist = Array.isArray(taskConfig?.mcpToolAllowlist) ? taskConfig.mcpToolAllowlist : [];
  const authMap = useMemo(() => parseMcpServerAuthMap(taskConfig), [taskConfig]);

  const patch = (partial) => onTaskConfigChange({ ...taskConfig, ...partial });

  const toggleServer = (serverId, enabled) => {
    const nextIds = enabled ? serverIds.filter((id) => id !== serverId) : [...serverIds, serverId];
    let nextAllowlist = allowlist;
    let nextAuth = authMap;
    if (enabled) {
      nextAllowlist = allowlist.filter((k) => !k.startsWith(`${serverId}::`));
      nextAuth = removeServerFromAuth(authMap, serverId);
    }
    patch({
      mcpServerIds: nextIds,
      mcpToolAllowlist: nextAllowlist,
      mcpServerAuth: nextAuth,
    });
  };

  const modalServer = modalServerId ? (mcpServers || []).find((s) => s.id === modalServerId) : null;

  return (
    <fieldset className="wf-field wf-brain-mcp-panel">
      <legend>MCP tool calling</legend>
      <label className="wf-brain-mcp-enable">
        <input
          type="checkbox"
          checked={!!taskConfig?.mcpToolCalling}
          onChange={(e) => patch({ mcpToolCalling: e.target.checked })}
        />
        Let LLM decide which MCP tools to call
      </label>
      <small className="wf-field-hint">
        {mcpLoadError
          ? mcpLoadError
          : (mcpServers || []).length
            ? 'Add MCP servers below. Each server has its own auth headers and optional tool filter.'
            : 'No healthy MCPs — connect servers in MCP Integrations first'}
      </small>

      {!!taskConfig?.mcpToolCalling && (
        <>
          <div className="wf-brain-mcp-add-row">
            <label className="wf-brain-mcp-add-label">
              Add MCP server
              <select
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id && !serverIds.includes(id)) {
                    patch({ mcpServerIds: [...serverIds, id] });
                  }
                }}
              >
                <option value="">— choose server —</option>
                {(mcpServers || [])
                  .filter((s) => !serverIds.includes(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.tools?.length ?? s.tool_count ?? 0} tools)
                    </option>
                  ))}
              </select>
            </label>
          </div>

          {serverIds.length === 0 && (
            <p className="wf-brain-mcp-empty">No MCP servers selected. Use the dropdown above to add one.</p>
          )}

          <ul className="wf-brain-mcp-server-list">
            {serverIds.map((serverId) => {
              const server = (mcpServers || []).find((s) => s.id === serverId);
              if (!server) {
                return (
                  <li key={serverId} className="wf-brain-mcp-server-card wf-brain-mcp-server-card-missing">
                    <span>
                      <code>{serverId}</code> (not in registry)
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggleServer(serverId, true)}>
                      Remove
                    </button>
                  </li>
                );
              }
              const toolPickCount = toolAllowlistForServer(allowlist, serverId).length;
              const hasAuth = serverAuthHasHeaders(authMap[serverId]);
              return (
                <li key={serverId} className="wf-brain-mcp-server-card">
                  <div className="wf-brain-mcp-server-main">
                    <strong>{server.name}</strong>
                    <span className="wf-brain-mcp-server-meta">
                      {server.tools?.length ?? 0} tools
                      {toolPickCount ? ` · ${toolPickCount} selected` : ' · all tools'}
                      {hasAuth ? ' · auth set' : ''}
                    </span>
                  </div>
                  <div className="wf-brain-mcp-server-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setModalServerId(serverId)}
                    >
                      Configure…
                    </button>
                    <button type="button" className="wf-btn-danger btn-sm" onClick={() => toggleServer(serverId, true)}>
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <label className="wf-field">
            Max tool rounds
            <input
              type="number"
              min={1}
              max={20}
              value={taskConfig?.mcpMaxToolRounds ?? 8}
              onChange={(e) =>
                patch({
                  mcpMaxToolRounds: Math.min(20, Math.max(1, Number(e.target.value) || 8)),
                })
              }
            />
          </label>
        </>
      )}

      {modalServer && (
        <ServerConfigModal
          server={modalServer}
          serverId={modalServerId}
          allowlist={allowlist}
          authHeadersJson={authMap[modalServerId] || '{}'}
          onAuthChange={(httpHeadersJson) =>
            patch({ mcpServerAuth: setServerAuthHeaders(authMap, modalServerId, httpHeadersJson) })
          }
          onAllowlistChange={(next) => patch({ mcpToolAllowlist: next })}
          onClose={() => setModalServerId(null)}
        />
      )}
    </fieldset>
  );
}
