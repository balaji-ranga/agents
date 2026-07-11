import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { buildMcpAuthPayload } from '../MaskedSecretInput';
import HttpHeadersEditor from '../HttpHeadersEditor';

const EMPTY_AUTH = { httpHeadersJson: '{}' };

function transportLabel(t) {
  if (t === 'sse') return 'SSE';
  if (t === 'stdio') return 'STDIO';
  return 'HTTP / Streamable HTTP';
}

function schemaToDefaultArgs(schema) {
  if (!schema?.properties) return '{}';
  const obj = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    if (v.default !== undefined) obj[k] = v.default;
    else if (v.type === 'string') obj[k] = '';
    else if (v.type === 'number' || v.type === 'integer') obj[k] = 0;
    else if (v.type === 'boolean') obj[k] = false;
    else if (v.type === 'array') obj[k] = [];
    else if (v.type === 'object') obj[k] = {};
  }
  return JSON.stringify(obj, null, 2);
}

export default function McpTestView() {
  const { serverId } = useParams();
  const [server, setServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectMeta, setConnectMeta] = useState(null);
  const [auth, setAuth] = useState(EMPTY_AUTH);
  const [toolSearch, setToolSearch] = useState('');
  const [capTab, setCapTab] = useState('tools');
  const [selectedTool, setSelectedTool] = useState('');
  const [testArgs, setTestArgs] = useState('{}');
  const [resultTab, setResultTab] = useState('response');
  const [testResult, setTestResult] = useState(null);
  const [testLoading, setTestLoading] = useState(false);
  const [callLog, setCallLog] = useState([]);

  const loadServer = useCallback(async (preserveAuth = false) => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.mcpServerGet(serverId);
      setServer(s);
      setConnected(s.status === 'healthy');
      if (!preserveAuth) setAuth(EMPTY_AUTH);
      const first = s.tools?.[0]?.name || '';
      setSelectedTool(first);
      if (first && s.tools?.[0]?.input_schema) {
        setTestArgs(schemaToDefaultArgs(s.tools[0].input_schema));
      } else {
        setTestArgs('{}');
      }
      setTestResult(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    loadServer();
  }, [loadServer]);

  const tools = server?.tools || [];
  const filteredTools = useMemo(() => {
    const q = toolSearch.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
    );
  }, [tools, toolSearch]);

  const activeTool = tools.find((t) => t.name === selectedTool);

  const selectTool = (name) => {
    setSelectedTool(name);
    const t = tools.find((x) => x.name === name);
    setTestArgs(schemaToDefaultArgs(t?.input_schema));
    setTestResult(null);
    setResultTab('response');
  };

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      if (auth.httpHeadersJson?.trim()) JSON.parse(auth.httpHeadersJson);
      const payload = buildMcpAuthPayload(auth.httpHeadersJson);
      const out = await api.mcpServerConnect(serverId, payload);
      setConnected(true);
      setConnectMeta(out);
      await loadServer(true);
    } catch (e) {
      setConnected(false);
      setError(e.message);
    } finally {
      setConnecting(false);
    }
  };

  const runTool = async () => {
    if (!selectedTool) return;
    setTestLoading(true);
    setTestResult(null);
    const started = Date.now();
    try {
      let args = {};
      try {
        args = JSON.parse(testArgs || '{}');
      } catch {
        throw new Error('Arguments must be valid JSON');
      }
      const authPayload = buildMcpAuthPayload(auth.httpHeadersJson);
      const out = await api.mcpServerCallTool(serverId, selectedTool, args, authPayload);
      setTestResult(out);
      setCallLog((prev) => [
        {
          id: Date.now(),
          tool: selectedTool,
          args,
          out,
          ms: out.latency_ms ?? Date.now() - started,
          at: new Date().toISOString(),
        },
        ...prev.slice(0, 19),
      ]);
    } catch (e) {
      setTestResult({ error: e.message });
    } finally {
      setTestLoading(false);
    }
  };

  if (loading && !server) {
    return (
      <div className="mcp-pg mcp-pg-test">
        <div className="mcp-pg-loading">
          <div className="mcp-pg-spinner" />
          <p>Loading testing interface…</p>
        </div>
      </div>
    );
  }

  if (!server && error) {
    return (
      <div className="mcp-pg mcp-pg-test">
        <div className="mcp-pg-alert mcp-pg-alert-error">{error}</div>
        <Link to="/integrations/mcp" className="mcp-pg-back">
          ← Back to registry
        </Link>
      </div>
    );
  }

  return (
    <div className="mcp-pg mcp-pg-test">
      <header className="mcp-pg-test-header">
        <div className="mcp-pg-test-header-left">
          <Link to="/integrations/mcp" className="mcp-pg-back">
            ← MCP Servers
          </Link>
          <h1>Test MCP Server</h1>
          <p className="mcp-pg-subtitle">{server.name}</p>
        </div>
        <div className="mcp-pg-connection-badge">
          <span className={`mcp-pg-dot ${connected ? 'online' : 'offline'}`} />
          {connected ? 'Connected' : 'Not connected'}
          {connectMeta?.latency_ms != null && connected && (
            <span className="mcp-pg-latency">{connectMeta.latency_ms}ms</span>
          )}
        </div>
      </header>

      {error && <div className="mcp-pg-alert mcp-pg-alert-error">{error}</div>}

      <section className="mcp-pg-connect-card">
        <h2>Connect to MCP Server</h2>
        <p className="mcp-pg-hint">Enter auth if required — tokens are never stored, only sent per request.</p>

        <div className="mcp-pg-connect-grid">
          <div className="mcp-pg-field">
            <span>Transport method</span>
            <div className="mcp-pg-segment mcp-pg-segment-readonly">
              <button type="button" className="active" disabled>
                {transportLabel(server.transport)}
                <small>{server.transport === 'sse' ? 'Streaming' : 'Standard · Recommended'}</small>
              </button>
            </div>
          </div>

          <label className="mcp-pg-field mcp-pg-field-wide">
            <span>Remote server URL</span>
            <input value={server.url} readOnly className="mcp-pg-readonly" />
          </label>

          <div className="mcp-pg-field mcp-pg-field-wide">
            <HttpHeadersEditor
              value={auth.httpHeadersJson}
              onChange={(httpHeadersJson) => setAuth({ ...auth, httpHeadersJson })}
            />
            <small className="mcp-pg-hint">Add Authorization, API keys, etc. — never stored, only sent per request.</small>
          </div>
        </div>

        <button
          type="button"
          className="mcp-pg-btn-primary mcp-pg-connect-btn"
          onClick={connect}
          disabled={connecting}
        >
          {connecting ? 'Connecting…' : connected ? 'Reconnect to server' : 'Connect to server'}
        </button>

        {server.server_info && (
          <div className="mcp-pg-server-info">
            <strong>{server.server_info.name || 'MCP Server'}</strong>
            {server.server_info.version && <span>v{server.server_info.version}</span>}
          </div>
        )}
      </section>

      {connected && tools.length > 0 && (
        <div className="mcp-pg-playground">
          <aside className="mcp-pg-sidebar">
            <div className="mcp-pg-cap-tabs">
              {['tools', 'prompts', 'resources'].map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={capTab === tab ? 'active' : ''}
                  disabled={tab !== 'tools'}
                  onClick={() => setCapTab(tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {tab !== 'tools' && <span className="mcp-pg-soon">Soon</span>}
                </button>
              ))}
            </div>

            {capTab === 'tools' && (
              <>
                <input
                  type="search"
                  className="mcp-pg-tool-search"
                  placeholder="Filter tools…"
                  value={toolSearch}
                  onChange={(e) => setToolSearch(e.target.value)}
                />
                <ul className="mcp-pg-tool-list">
                  {filteredTools.map((t) => (
                    <li key={t.name}>
                      <button
                        type="button"
                        className={selectedTool === t.name ? 'active' : ''}
                        onClick={() => selectTool(t.name)}
                      >
                        <span className="mcp-pg-tool-name">{t.name}</span>
                        {t.description && <span className="mcp-pg-tool-desc">{t.description}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>

          <main className="mcp-pg-workspace">
            {activeTool ? (
              <>
                <div className="mcp-pg-tool-header">
                  <h2>{activeTool.name}</h2>
                  <p>{activeTool.description || 'No description provided.'}</p>
                </div>

                {activeTool.input_schema && Object.keys(activeTool.input_schema).length > 0 && (
                  <details className="mcp-pg-schema">
                    <summary>Input schema</summary>
                    <pre>{JSON.stringify(activeTool.input_schema, null, 2)}</pre>
                  </details>
                )}

                <label className="mcp-pg-field">
                  <span>Tool arguments (JSON)</span>
                  <textarea
                    className="mcp-pg-code"
                    rows={8}
                    value={testArgs}
                    onChange={(e) => setTestArgs(e.target.value)}
                  />
                </label>

                <button
                  type="button"
                  className="mcp-pg-btn-primary"
                  onClick={runTool}
                  disabled={testLoading}
                >
                  {testLoading ? 'Executing…' : 'Execute tool'}
                </button>

                {testResult && (
                  <div className="mcp-pg-result-panel">
                    <div className="mcp-pg-result-tabs">
                      <button
                        type="button"
                        className={resultTab === 'response' ? 'active' : ''}
                        onClick={() => setResultTab('response')}
                      >
                        Response
                      </button>
                      <button
                        type="button"
                        className={resultTab === 'raw' ? 'active' : ''}
                        onClick={() => setResultTab('raw')}
                      >
                        Raw JSON
                      </button>
                      <button
                        type="button"
                        className={resultTab === 'logs' ? 'active' : ''}
                        onClick={() => setResultTab('logs')}
                      >
                        Session log
                      </button>
                    </div>
                    {resultTab === 'response' && (
                      <pre className="mcp-pg-result">
                        {testResult.error
                          ? testResult.error
                          : testResult.text || '(empty text response)'}
                      </pre>
                    )}
                    {resultTab === 'raw' && (
                      <pre className="mcp-pg-result">
                        {testResult.error
                          ? JSON.stringify({ error: testResult.error }, null, 2)
                          : JSON.stringify(testResult, null, 2)}
                      </pre>
                    )}
                    {resultTab === 'logs' && (
                      <div className="mcp-pg-log-list">
                        {!callLog.length && <p className="mcp-pg-hint">No tool calls yet this session.</p>}
                        {callLog.map((entry) => (
                          <details key={entry.id} className="mcp-pg-log-entry">
                            <summary>
                              {entry.tool} · {entry.ms}ms · {new Date(entry.at).toLocaleTimeString()}
                            </summary>
                            <pre>{JSON.stringify({ arguments: entry.args, response: entry.out }, null, 2)}</pre>
                          </details>
                        ))}
                      </div>
                    )}
                    {testResult.latency_ms != null && !testResult.error && (
                      <p className="mcp-pg-hint">Latency: {testResult.latency_ms}ms</p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="mcp-pg-empty-workspace">
                <p>Select a tool from the sidebar to execute it.</p>
              </div>
            )}
          </main>
        </div>
      )}

      {connected && !tools.length && (
        <div className="mcp-pg-empty">
          <p>Connected, but no tools were returned by this server.</p>
          <button type="button" className="mcp-pg-btn-ghost" onClick={connect}>
            Refresh connection
          </button>
        </div>
      )}

      {!connected && !connecting && (
        <div className="mcp-pg-empty mcp-pg-empty-connect">
          <p>Connect to explore tools, prompts, and resources from this server.</p>
        </div>
      )}
    </div>
  );
}
