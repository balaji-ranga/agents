import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { formatLocalDateTime } from '../utils/formatDateTime.js';
import { api } from '../api.js';
import {
  workflowNodeTypes,
  PALETTE_ITEMS,
  defaultNodeData,
  graphToFlow,
  flowToGraph,
} from '../components/workflow/WorkflowNodes.jsx';
import { InputOutputPanel, applyCatalogToNewNode } from '../components/workflow/InputOutputPanel.jsx';
import WorkflowAgentChat from '../components/workflow/WorkflowAgentChat.jsx';
import {
  formatNodeStepLabel,
  getSourceOutputKeyOptions,
  listPriorNodes,
} from '../components/workflow/workflowEditorUtils.js';
import ActionFeedbackBanner from '../components/ActionFeedbackBanner.jsx';
import { useActionFeedback } from '../hooks/useActionFeedback.js';

function migrateNodeWithCatalog(node, catalog) {
  const entry = catalog?.find((t) => t.type === node.type);
  if (!entry) return node;
  const data = { ...node.data };
  if (!data.inputBindings?.length && entry.inputs?.length) {
    data.inputBindings = entry.inputs.map((inp) => ({
      id: inp.id,
      label: inp.label,
      mode: inp.defaultMode || inp.mode || 'static',
      value: data[inp.id] || '',
      sourceNodeId: data.inputFrom || '',
      sourceOutputKey: 'text',
    }));
  }
  if (!data.outputs?.length && entry.outputs?.length) {
    data.outputs = entry.outputs.map((o) => ({ ...o }));
  }
  if (!data.taskConfig && entry.configFields?.length) {
    data.taskConfig = {};
    for (const f of entry.configFields) {
      data.taskConfig[f.id] = f.default ?? (f.type === 'boolean' ? false : '');
    }
    if (node.type === 'email') data.taskConfig.useEnvSmtp = true;
  }
  return { ...node, data };
}

function PropertiesPanel({ node, agents, tools, taskCatalog, allNodes, edges, onChange, onDelete }) {
  if (!node) {
    return (
      <div className="wf-props">
        <h3>Properties</h3>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Select a node to edit its settings.</p>
      </div>
    );
  }

  const data = node.data || {};
  const set = (patch) => onChange(node.id, { ...data, ...patch });

  return (
    <div className="wf-props">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>{data.label || node.type}</h3>
        <button type="button" className="wf-btn-danger" onClick={() => onDelete(node.id)}>
          Delete
        </button>
      </div>

      <div className="wf-step-id">
        <span className="wf-step-id-label">Step ID</span>
        <code className="wf-step-id-value">{node.id}</code>
        <small>Use this ID in IF/While conditions and {'{{nodeId.key}}'} templates</small>
      </div>

      <label className="wf-field">
        Label
        <input value={data.label || ''} onChange={(e) => set({ label: e.target.value })} />
      </label>

      {node.type === 'trigger' && (
        <>
          <fieldset className="wf-field">
            <legend>Trigger modes</legend>
            {['manual', 'schedule', 'chat'].map((mode) => (
              <label key={mode} style={{ display: 'block', marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={(data.triggerModes || []).includes(mode)}
                  onChange={(e) => {
                    const modes = new Set(data.triggerModes || ['manual']);
                    if (e.target.checked) modes.add(mode);
                    else modes.delete(mode);
                    const patch = { triggerModes: [...modes] };
                    if (mode === 'schedule' && !e.target.checked) patch.scheduleCron = '';
                    if (mode === 'chat' && !e.target.checked) patch.chatPhrase = '';
                    set(patch);
                  }}
                />{' '}
                {mode}
              </label>
            ))}
          </fieldset>
          <label className="wf-field">
            Schedule (cron)
            <input
              placeholder="0 9 * * *"
              value={data.scheduleCron || ''}
              onChange={(e) => set({ scheduleCron: e.target.value })}
            />
            <small>Used when schedule mode is enabled</small>
          </label>
          <label className="wf-field">
            Chat trigger phrase
            <input
              placeholder="run research workflow"
              value={data.chatPhrase || ''}
              onChange={(e) => set({ chatPhrase: e.target.value })}
            />
            <small>Message containing this phrase starts the workflow</small>
          </label>
        </>
      )}

      {node.type === 'agent' && (
        <>
          <label className="wf-field">
            Agent
            <select
              value={data.agentId || ''}
              onChange={(e) => {
                const a = agents.find((x) => x.id === e.target.value);
                set({ agentId: e.target.value, agentName: a?.name || e.target.value });
              }}
            >
              <option value="">— select —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                </option>
              ))}
            </select>
          </label>
          <label className="wf-field">
            Prompt template
            <textarea
              rows={6}
              value={data.prompt || ''}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder="Use {{input}} for bound prompt input"
            />
          </label>
        </>
      )}

      {node.type === 'tool' && (
        <>
          <label className="wf-field">
            Content tool
            <select value={data.toolName || ''} onChange={(e) => set({ toolName: e.target.value })}>
              <option value="">— select —</option>
              {tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.display_name || t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="wf-field">
            Tool payload (JSON)
            <textarea
              rows={5}
              value={JSON.stringify(data.toolPayload || {}, null, 2)}
              onChange={(e) => {
                try {
                  set({ toolPayload: JSON.parse(e.target.value) });
                } catch (_) {}
              }}
            />
          </label>
        </>
      )}

      {(node.type === 'brain' || node.type === 'if' || node.type === 'while' || node.type === 'ceo_approval') && (
        <>
          {(node.type === 'if' || node.type === 'while') && (
            <>
              <label className="wf-field">
                Source step
                <select
                  value={data.taskConfig?.sourceNodeId || ''}
                  onChange={(e) => {
                    const sourceNodeId = e.target.value;
                    const sourceNode = allNodes.find((n) => n.id === sourceNodeId);
                    const keys = getSourceOutputKeyOptions(sourceNode, taskCatalog).map((o) => o.value);
                    const patch = { sourceNodeId };
                    const currentKey = data.taskConfig?.sourceOutputKey || 'text';
                    if (keys.length && !keys.includes(currentKey)) {
                      patch.sourceOutputKey = keys.includes('text') ? 'text' : keys[0];
                    }
                    set({ taskConfig: { ...data.taskConfig, ...patch } });
                  }}
                >
                  <option value="">— select step —</option>
                  {listPriorNodes(allNodes, node.id).map((n) => (
                    <option key={n.id} value={n.id}>
                      {formatNodeStepLabel(n)}
                    </option>
                  ))}
                </select>
                <small>Step ID is shown on each canvas node and in this list</small>
              </label>
              <label className="wf-field">
                Output key
                {(() => {
                  const sourceNode = allNodes.find((n) => n.id === data.taskConfig?.sourceNodeId);
                  const options = getSourceOutputKeyOptions(sourceNode, taskCatalog);
                  const currentKey = data.taskConfig?.sourceOutputKey || 'text';
                  if (!options.length) {
                    return (
                      <input
                        value={currentKey}
                        onChange={(e) =>
                          set({ taskConfig: { ...data.taskConfig, sourceOutputKey: e.target.value } })
                        }
                        placeholder="e.g. text, decision, comment"
                      />
                    );
                  }
                  const hasCurrent = options.some((o) => o.value === currentKey);
                  const displayOptions =
                    hasCurrent || !currentKey
                      ? options
                      : [...options, { value: currentKey, label: `${currentKey} (saved)` }];
                  return (
                    <select
                      value={currentKey}
                      onChange={(e) =>
                        set({ taskConfig: { ...data.taskConfig, sourceOutputKey: e.target.value } })
                      }
                    >
                      {displayOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  );
                })()}
              </label>
              <label className="wf-field">
                Operator
                <select
                  value={data.taskConfig?.operator || 'contains'}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, operator: e.target.value } })}
                >
                  {['eq', 'ne', 'contains', 'not_contains', 'gt', 'lt', 'empty', 'not_empty', 'approved', 'rejected'].map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wf-field">
                Compare value
                <input
                  value={data.taskConfig?.compareValue || ''}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, compareValue: e.target.value } })}
                />
              </label>
              {node.type === 'while' && (
                <label className="wf-field">
                  Max iterations
                  <input
                    type="number"
                    value={data.taskConfig?.maxIterations ?? 10}
                    onChange={(e) =>
                      set({ taskConfig: { ...data.taskConfig, maxIterations: Number(e.target.value) || 10 } })
                    }
                  />
                </label>
              )}
            </>
          )}
          {node.type === 'brain' && (
            <>
              <label className="wf-field">
                Model source
                <select
                  value={data.taskConfig?.modelSource || 'openai'}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, modelSource: e.target.value } })}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="ollama">Ollama (local)</option>
                </select>
              </label>
              <label className="wf-field">
                API endpoint
                <input
                  value={data.taskConfig?.apiEndpoint || ''}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, apiEndpoint: e.target.value } })}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="wf-field">
                API key (optional — uses env)
                <input
                  type="password"
                  value={data.taskConfig?.apiKey || ''}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, apiKey: e.target.value } })}
                />
              </label>
              <label className="wf-field">
                Model name
                <input
                  value={data.taskConfig?.model || ''}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, model: e.target.value } })}
                />
              </label>
              <label className="wf-field">
                Max tokens
                <input
                  type="number"
                  value={data.taskConfig?.maxTokens ?? 1024}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, maxTokens: Number(e.target.value) } })}
                />
              </label>
              <label className="wf-field">
                System prompt
                <textarea
                  rows={6}
                  value={data.taskConfig?.systemPrompt || ''}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, systemPrompt: e.target.value } })}
                  placeholder="Use {{input}} or {{nodeId.text}} bind variables"
                />
              </label>
              <label className="wf-field">
                MCP endpoints (JSON array)
                <textarea
                  rows={3}
                  value={
                    typeof data.taskConfig?.mcpEndpoints === 'string'
                      ? data.taskConfig.mcpEndpoints
                      : JSON.stringify(data.taskConfig?.mcpEndpoints || [], null, 2)
                  }
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, mcpEndpoints: e.target.value } })}
                />
              </label>
            </>
          )}
          {node.type === 'ceo_approval' && (
            <>
              <label className="wf-field">
                Kanban title
                <input
                  value={data.taskConfig?.title || ''}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, title: e.target.value } })}
                />
              </label>
              <label className="wf-field">
                Instructions for CEO
                <textarea
                  rows={4}
                  value={data.taskConfig?.instructions || ''}
                  onChange={(e) => set({ taskConfig: { ...data.taskConfig, instructions: e.target.value } })}
                />
              </label>
            </>
          )}
        </>
      )}

      <InputOutputPanel
        node={node}
        taskCatalog={taskCatalog}
        allNodes={allNodes}
        edges={edges}
        onChange={(patch) => onChange(node.id, { ...data, ...patch })}
      />
    </div>
  );
}

function EditorInner({ workflowId }) {
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState(null);
  const [agents, setAgents] = useState([]);
  const [tools, setTools] = useState([]);
  const [audit, setAudit] = useState([]);
  const [saving, setSaving] = useState(false);
  const { feedback, showSuccess, showError, clearFeedback } = useActionFeedback();
  const [selectedId, setSelectedId] = useState(null);
  const [taskCatalog, setTaskCatalog] = useState([]);
  const [runInput, setRunInput] = useState('');

  const initial = useMemo(() => graphToFlow(workflow?.draft_graph), [workflow?.id]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  const load = useCallback(() => {
    if (!workflowId) return;
    Promise.all([
      api.agentWorkflowGet(workflowId),
      api.agentsList(),
      api.contentToolsMeta(),
      api.agentWorkflowAudit(workflowId),
      api.agentWorkflowTaskTypes(),
    ])
      .then(([wf, agentList, toolMeta, auditRes, catalogRes]) => {
        const catalog = catalogRes.task_types || [];
        setTaskCatalog(catalog);
        setWorkflow(wf);
        setAgents(agentList || []);
        setTools((toolMeta?.tools || []).filter((t) => t.enabled !== 0 && t.enabled !== false));
        setAudit(auditRes.audit || []);
        const flow = graphToFlow(wf.draft_graph);
        setNodes(flow.nodes.map((n) => migrateNodeWithCatalog(n, catalog)));
        setEdges(flow.edges);
      })
      .catch((e) => showError(e.message || 'Failed to load workflow'));
  }, [workflowId, setNodes, setEdges, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: 'var(--accent)' } }, eds)),
    [setEdges]
  );

  const selectedNode = nodes.find((n) => n.id === selectedId);

  const updateNodeData = (nodeId, data) => {
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data } : n)));
  };

  const deleteNode = (nodeId) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedId(null);
  };

  const applyAgentGraph = useCallback(
    (draftGraph, meta) => {
      if (!draftGraph) return;
      const flow = graphToFlow(draftGraph);
      setNodes(flow.nodes.map((n) => migrateNodeWithCatalog(n, taskCatalog)));
      setEdges(flow.edges);
      if (meta?.name) {
        setWorkflow((w) => (w ? { ...w, name: meta.name, status: meta.status || w.status } : w));
      }
    },
    [taskCatalog, setNodes, setEdges]
  );

  const onAgentWorkflowCreated = useCallback(
    (newId) => {
      if (newId && newId !== workflowId) {
        navigate(`/workflows/${newId}/edit`, { replace: true });
      } else {
        load();
      }
    },
    [workflowId, navigate, load]
  );

  const onDragStart = (event, item) => {
    event.dataTransfer.setData('application/workflow-node', JSON.stringify({ type: item.type }));
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (event) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/workflow-node');
    const agentRaw = event.dataTransfer.getData('application/workflow-agent');
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = { x: event.clientX - bounds.left - 80, y: event.clientY - bounds.top - 20 };

    if (agentRaw) {
      const agent = JSON.parse(agentRaw);
      const entry = taskCatalog.find((t) => t.type === 'agent');
      const node = applyCatalogToNewNode('agent', entry, position);
      node.data.agentId = agent.id;
      node.data.agentName = agent.name;
      node.data.label = agent.name;
      node.data.prompt =
        'Write an email body with a warm greeting and a bullet list of job opportunities you discovered. Plain text only, ready to send.\n\n{{input}}';
      setNodes((nds) => [...nds, node]);
      return;
    }

    if (!raw) return;
    const { type } = JSON.parse(raw);
    const entry = taskCatalog.find((t) => t.type === type);
    const node = entry ? applyCatalogToNewNode(type, entry, position) : defaultNodeData(type, { position });
    setNodes((nds) => [...nds, node]);
  };

  const buildGraphPayload = () => flowToGraph(nodes, edges, { x: 0, y: 0, zoom: 1 });

  const extractTriggerSettings = () => {
    const trigger = nodes.find((n) => n.type === 'trigger');
    const modes = trigger?.data?.triggerModes || ['manual'];
    return {
      trigger_modes: modes,
      schedule_cron: modes.includes('schedule') ? trigger?.data?.scheduleCron || '' : '',
      chat_trigger_phrase: modes.includes('chat') ? trigger?.data?.chatPhrase || '' : '',
    };
  };

  const saveDraft = async () => {
    setSaving(true);
    try {
      const graph = buildGraphPayload();
      const triggerSettings = extractTriggerSettings();
      const updated = await api.agentWorkflowUpdate(workflowId, {
        name: workflow.name,
        description: workflow.description,
        graph,
        ...triggerSettings,
      });
      const final =
        updated.status === 'published'
          ? await api.agentWorkflowUpdateTriggers(workflowId, triggerSettings)
          : updated;
      setWorkflow(final);
      const auditRes = await api.agentWorkflowAudit(workflowId);
      setAudit(auditRes.audit || []);
      showSuccess('Draft saved');
    } catch (e) {
      showError(e.message || 'Failed to save draft');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setSaving(true);
    try {
      const graph = buildGraphPayload();
      const triggerSettings = extractTriggerSettings();
      await api.agentWorkflowUpdate(workflowId, {
        name: workflow.name,
        description: workflow.description,
        graph,
        ...triggerSettings,
      });
      const updated = await api.agentWorkflowPublish(workflowId);
      if (updated.status === 'published') {
        await api.agentWorkflowUpdateTriggers(workflowId, triggerSettings);
      }
      setWorkflow(updated);
      const auditRes = await api.agentWorkflowAudit(workflowId);
      setAudit(auditRes.audit || []);
      showSuccess('Workflow published');
    } catch (e) {
      showError(e.message || 'Failed to publish');
    } finally {
      setSaving(false);
    }
  };

  const runWorkflow = async () => {
    setSaving(true);
    try {
      const run = await api.agentWorkflowRun(workflowId, { input: runInput });
      showSuccess(`Run #${run.run_number} started`);
      navigate(`/workflows?run_id=${run.id}`);
    } catch (e) {
      showError(e.message || 'Failed to start run');
    } finally {
      setSaving(false);
    }
  };

  if (!workflow) {
    return (
      <div style={{ padding: '2rem' }}>
        <ActionFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
        Loading editor…
      </div>
    );
  }

  return (
    <div className="wf-editor-layout">
      <header className="wf-editor-header">
        <div>
          <Link to="/workflows" style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            ← Workflows
          </Link>
          <h1 style={{ margin: '0.25rem 0' }}>{workflow.name}</h1>
          <span className={`wf-status wf-status-${workflow.status}`}>{workflow.status}</span>
        </div>
        <div className="wf-editor-actions">
          <input
            className="wf-run-input"
            placeholder="Run input (optional)"
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
          />
          <button type="button" className="wf-btn" onClick={saveDraft} disabled={saving}>
            Save draft
          </button>
          <button type="button" className="wf-btn-primary" onClick={publish} disabled={saving}>
            Publish
          </button>
          <button
            type="button"
            className="wf-btn-accent"
            onClick={runWorkflow}
            disabled={saving || workflow.status !== 'published'}
            title={workflow.status !== 'published' ? 'Publish first' : 'Run workflow'}
          >
            Run
          </button>
        </div>
      </header>

      <ActionFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />

      <div className="wf-editor-body">
        <aside className="wf-palette">
          <h3>Nodes</h3>
          {PALETTE_ITEMS.map((item) => (
            <div
              key={item.type}
              className="wf-palette-item"
              draggable
              onDragStart={(e) => onDragStart(e, item)}
              style={{ borderLeftColor: item.color }}
            >
              <strong>{item.label}</strong>
              <small>{item.desc}</small>
            </div>
          ))}

          <h3 style={{ marginTop: '1.5rem' }}>Agents</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Drag agents onto canvas</p>
          <div className="wf-agent-list">
            {agents
              .filter((a) => !Number(a.is_coo))
              .map((a) => (
                <div
                  key={a.id}
                  className="wf-palette-item wf-agent-chip"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/workflow-agent', JSON.stringify(a));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  {a.name}
                </div>
              ))}
          </div>
        </aside>

        <div className="wf-canvas" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={workflowNodeTypes}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background gap={16} color="#2a2a2e" />
            <Controls position="top-left" showInteractive={false} />
            <MiniMap
              position="bottom-left"
              maskColor="rgba(15, 15, 18, 0.75)"
              nodeColor={(n) => PALETTE_ITEMS.find((p) => p.type === n.type)?.color || '#6366f1'}
            />
          </ReactFlow>
        </div>

        <aside className="wf-sidebar-right">
          <PropertiesPanel
            node={selectedNode}
            agents={agents}
            tools={tools}
            taskCatalog={taskCatalog}
            allNodes={nodes}
            edges={edges}
            onChange={updateNodeData}
            onDelete={deleteNode}
          />

          <div className="wf-audit">
            <h3>Audit trail</h3>
            <ul>
              {audit.slice(0, 15).map((a) => (
                <li key={a.id}>
                  <strong>{a.action}</strong>
                  <div>{a.summary}</div>
                  <small>
                    {a.changed_by_name || a.changed_by || 'system'} · {formatLocalDateTime(a.created_at)}
                  </small>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      <WorkflowAgentChat
        workflowId={workflowId}
        onGraphUpdated={applyAgentGraph}
        onWorkflowCreated={onAgentWorkflowCreated}
        onWorkflowMetaUpdated={(meta) => {
          if (meta?.name) setWorkflow((w) => (w ? { ...w, ...meta } : w));
        }}
      />
    </div>
  );
}

export default function AgentWorkflowEditor() {
  const { workflowId } = useParams();
  return (
    <div className="page-wf-editor">
      <ReactFlowProvider>
        <EditorInner workflowId={workflowId} />
      </ReactFlowProvider>
    </div>
  );
}
