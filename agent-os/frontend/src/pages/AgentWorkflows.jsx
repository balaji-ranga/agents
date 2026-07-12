import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { formatLocalDateTime } from '../utils/formatDateTime.js';
import { api } from '../api.js';
import WorkflowStepTooltip from '../components/WorkflowStepTooltip.jsx';
import { summarizeStepIo } from '../utils/workflowStepIo.js';
import ActionFeedbackBanner from '../components/ActionFeedbackBanner.jsx';
import { useActionFeedback } from '../hooks/useActionFeedback.js';
import WorkflowAgentChat from '../components/workflow/WorkflowAgentChat.jsx';
import {
  buildWorkflowExportDocument,
  downloadWorkflowJson,
  parseWorkflowImportDocument,
  readJsonFile,
} from '../utils/workflowDefinitionJson.js';

const STATUS_COLORS = {
  completed: '#16a34a',
  running: '#2563eb',
  listening: '#0284c7',
  failed: '#dc2626',
  paused: '#d97706',
  draft: '#a3a3a3',
  published: '#16a34a',
};

function StatusBadge({ status }) {
  return (
    <span
      style={{
        fontSize: '0.7rem',
        padding: '2px 8px',
        borderRadius: 999,
        background: `${STATUS_COLORS[status] || 'var(--muted)'}22`,
        color: STATUS_COLORS[status] || 'var(--muted)',
        textTransform: 'uppercase',
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function confirmAction(message) {
  return window.confirm(message);
}

export default function AgentWorkflows() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns] = useState([]);
  const [runsMeta, setRunsMeta] = useState({ total: 0, page: 1, pages: 0, limit: 20 });
  const [defSearch, setDefSearch] = useState('');
  const [runSearch, setRunSearch] = useState('');
  const [runSearchDebounced, setRunSearchDebounced] = useState('');
  const [runPage, setRunPage] = useState(1);
  const RUN_PAGE_SIZE = 20;
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const { feedback, showSuccess, showError, clearFeedback } = useActionFeedback();
  const [newName, setNewName] = useState('');
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const importFileRef = useRef(null);

  const loadTemplates = useCallback(() => {
    return api.agentWorkflowTemplates().then((tplRes) => setTemplates(tplRes.templates || []));
  }, []);

  const loadDefinitions = useCallback(() => {
    return api
      .agentWorkflowList({ q: defSearch.trim() || undefined })
      .then((wfRes) => setWorkflows(wfRes.workflows || []))
      .catch((e) => showError(e.message || 'Failed to load workflows'));
  }, [defSearch, showError]);

  const loadRuns = useCallback(() => {
    return api
      .agentWorkflowRuns({ page: runPage, limit: RUN_PAGE_SIZE, q: runSearchDebounced.trim() || undefined })
      .then((runsRes) => {
        setRuns(runsRes.runs || []);
        setRunsMeta({
          total: runsRes.total ?? 0,
          page: runsRes.page ?? runPage,
          pages: runsRes.pages ?? 0,
          limit: runsRes.limit ?? RUN_PAGE_SIZE,
        });
      })
      .catch((e) => showError(e.message || 'Failed to load runs'));
  }, [runPage, runSearchDebounced, showError]);

  const refreshAll = useCallback(() => {
    setLoading(true);
    Promise.all([loadDefinitions(), loadRuns(), loadTemplates()]).finally(() => setLoading(false));
  }, [loadDefinitions, loadRuns, loadTemplates]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      loadDefinitions().finally(() => setLoading(false));
    }, defSearch ? 300 : 0);
    return () => clearTimeout(t);
  }, [defSearch, loadDefinitions]);

  useEffect(() => {
    const t = setTimeout(() => {
      setRunSearchDebounced(runSearch);
      setRunPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [runSearch]);

  useEffect(() => {
    setLoading(true);
    loadRuns().finally(() => setLoading(false));
  }, [runPage, runSearchDebounced, loadRuns]);

  const loadRun = useCallback((runId) => {
    if (!runId) return;
    api
      .agentWorkflowRunGet(runId)
      .then(setSelectedRun)
      .catch((e) => showError(e.message || 'Failed to load run'));
  }, [showError]);

  useEffect(() => {
    const runId = searchParams.get('run_id');
    if (runId) loadRun(Number(runId));
    else setSelectedRun(null);
  }, [searchParams, loadRun]);

  useEffect(() => {
    if (!selectedRun || !['running', 'listening'].includes(selectedRun.status)) return;
    const hasListening = (selectedRun.steps || []).some((s) => s.status === 'listening');
    const interval = hasListening || selectedRun.status === 'running' ? 2000 : 5000;
    const t = setInterval(() => loadRun(selectedRun.id), interval);
    return () => clearInterval(t);
  }, [selectedRun?.id, selectedRun?.status, selectedRun?.steps, loadRun]);

  const withBusy = async (key, fn, successMessage) => {
    setBusy(key);
    try {
      const result = await fn();
      if (successMessage) showSuccess(successMessage);
      refreshAll();
      return result;
    } catch (e) {
      showError(e.message || 'Action failed');
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const createWorkflow = async () => {
    if (!newName.trim() && !selectedTemplate) return;
    try {
      const body = selectedTemplate
        ? { template_id: selectedTemplate, name: newName.trim() || undefined }
        : {
            name: newName.trim(),
            graph: {
              nodes: [
                {
                  id: 'trigger-1',
                  type: 'trigger',
                  position: { x: 80, y: 120 },
                  data: { label: 'Start', triggerModes: ['manual'], scheduleCron: '', chatPhrase: '' },
                },
              ],
              edges: [],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
          };
      const wf = await api.agentWorkflowCreate(body);
      setNewName('');
      setSelectedTemplate('');
      showSuccess(`Workflow "${wf.name}" created`);
      navigate(`/workflows/${wf.id}/edit`);
    } catch (e) {
      showError(e.message || 'Failed to create workflow');
    }
  };

  const exportWorkflowJson = async (wf) => {
    setBusy(`export-${wf.id}`);
    try {
      const full = await api.agentWorkflowGet(wf.id);
      const doc = buildWorkflowExportDocument({
        name: full.name,
        description: full.description,
        graph: full.draft_graph,
        variables: full.variables || {},
        trigger_modes: full.trigger_modes,
        schedule_cron: full.schedule_cron,
        chat_trigger_phrase: full.chat_trigger_phrase,
        source_id: full.id,
      });
      downloadWorkflowJson(doc, full.name || full.id);
      showSuccess(`Exported "${full.name}"`);
    } catch (e) {
      showError(e.message || 'Failed to export workflow');
    } finally {
      setBusy(null);
    }
  };

  const importWorkflowJson = async (file) => {
    if (!file) return;
    setBusy('import-json');
    try {
      const raw = await readJsonFile(file);
      const parsed = parseWorkflowImportDocument(raw);
      const name = newName.trim() || parsed.name;
      const wf = await api.agentWorkflowCreate({
        name,
        description: parsed.description,
        graph: parsed.graph,
        variables: parsed.variables,
        trigger_modes: parsed.trigger_modes,
        schedule_cron: parsed.schedule_cron,
        chat_trigger_phrase: parsed.chat_trigger_phrase,
      });
      setNewName('');
      showSuccess(`Imported "${wf.name}"`);
      navigate(`/workflows/${wf.id}/edit`);
    } catch (e) {
      showError(e.message || 'Failed to import workflow JSON');
    } finally {
      setBusy(null);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  const runWorkflow = async (wf) => {
    try {
      const run = await api.agentWorkflowRun(wf.id, { input: '' });
      setSearchParams({ run_id: String(run.id) });
      if (run.status === 'completed') {
        showSuccess(`Run #${run.run_number} completed for "${wf.name}"`);
      } else if (run.status === 'failed') {
        showError(`Run #${run.run_number} failed: ${run.error_message || 'unknown error'}`);
      } else {
        showSuccess(`Run #${run.run_number} started for "${wf.name}"`);
      }
      refreshAll();
    } catch (e) {
      showError(e.message || 'Failed to start run');
    }
  };

  const togglePauseWorkflow = (wf) =>
    withBusy(
      `wf-${wf.id}`,
      async () => {
        if (wf.paused) await api.agentWorkflowResume(wf.id);
        else await api.agentWorkflowPause(wf.id);
      },
      wf.paused ? `"${wf.name}" resumed — triggers enabled` : `"${wf.name}" paused — triggers disabled`
    );

  const deleteWorkflow = (wf) => {
    if (!confirmAction(`Delete workflow "${wf.name}"? All runs and Kanban tasks will be removed.`)) return;
    withBusy(`del-wf-${wf.id}`, async () => {
      await api.agentWorkflowDelete(wf.id);
      if (selectedRun?.definition_id === wf.id) setSearchParams({});
    }, `"${wf.name}" deleted`);
  };

  const setManualOnly = (wf) => {
    if (
      !confirmAction(
        `Set "${wf.name}" to manual trigger only? Schedule and chat triggers will be cleared immediately.`
      )
    ) {
      return;
    }
    withBusy(
      `trig-${wf.id}`,
      () =>
        api.agentWorkflowUpdateTriggers(wf.id, {
          trigger_modes: ['manual'],
          schedule_cron: '',
          chat_trigger_phrase: '',
        }),
      `"${wf.name}" set to manual trigger only`
    );
  };

  const pauseRun = (run, e) => {
    e?.stopPropagation();
    withBusy(
      `run-pause-${run.id}`,
      async () => {
        await api.agentWorkflowRunPause(run.id);
        if (selectedRun?.id === run.id) loadRun(run.id);
      },
      `Run #${run.run_number} paused`
    );
  };

  const deleteRun = (run, e) => {
    e?.stopPropagation();
    if (!confirmAction(`Delete run #${run.run_number}? Kanban tasks for this run will be removed.`)) return;
    withBusy(
      `run-del-${run.id}`,
      async () => {
        await api.agentWorkflowRunDelete(run.id);
        if (selectedRun?.id === run.id) setSearchParams({});
      },
      `Run #${run.run_number} deleted`
    );
  };

  const stopListenStep = (run, nodeId, e) => {
    e?.stopPropagation();
    if (!confirmAction(`Stop SSE listen on step "${nodeId}" for run #${run.run_number}?`)) return;
    withBusy(
      `stop-listen-${run.id}-${nodeId}`,
      async () => {
        await api.agentWorkflowStopListen(run.id, nodeId);
        loadRun(run.id);
      },
      'Listen stopped'
    );
  };

  const listeningSteps = (selectedRun?.steps || []).filter((s) => s.status === 'listening');
  const stepRepeatCounts = useMemo(() => {
    const counts = {};
    for (const step of selectedRun?.steps || []) {
      counts[step.node_id] = (counts[step.node_id] || 0) + 1;
    }
    return counts;
  }, [selectedRun?.steps]);

  const pauseAllRuns = () => {
    if (!confirmAction('Pause all active workflow runs? Kanban tasks for those runs will be cleared.')) return;
    withBusy('pause-all', () => api.agentWorkflowRunsPauseAll(), 'All active runs paused');
  };

  const deleteAllRuns = () => {
    if (!confirmAction('Delete ALL workflow runs? Kanban tasks for those runs will be removed.')) return;
    withBusy(
      'delete-all',
      async () => {
        await api.agentWorkflowRunsDeleteAll();
        setSearchParams({});
      },
      'All workflow runs deleted'
    );
  };

  return (
    <div className="page workflows-page" style={{ padding: '1.5rem', maxWidth: '100%' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Workflows</h1>
          <p style={{ color: 'var(--muted)', margin: '0.5rem 0 0' }}>
            Design, publish, and run custom agent workflows (separate from Job workflows).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json,.workflow.json"
            style={{ display: 'none' }}
            onChange={(e) => importWorkflowJson(e.target.files?.[0])}
          />
          <select
            value={selectedTemplate}
            onChange={(e) => setSelectedTemplate(e.target.value)}
            style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', minWidth: 200 }}
          >
            <option value="">Blank workflow</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.category === 'job' ? 'JOB: ' : ''}
                {t.name}
              </option>
            ))}
          </select>
          <input
            placeholder={selectedTemplate ? 'Optional name override' : 'New workflow name'}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
          />
          <button
            type="button"
            className="wf-btn-primary"
            onClick={createWorkflow}
            disabled={!selectedTemplate && !newName.trim()}
          >
            + New workflow
          </button>
          <button
            type="button"
            className="wf-btn"
            disabled={busy === 'import-json'}
            onClick={() => importFileRef.current?.click()}
            title="Create a new workflow from a .workflow.json export"
          >
            Import JSON
          </button>
        </div>
      </header>

      <ActionFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}

      <section style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0 }}>Definitions</h2>
          <div className="wf-search-row" style={{ marginBottom: 0 }}>
            <input
              type="search"
              className="wf-search-input"
              placeholder="Search by name or id…"
              value={defSearch}
              onChange={(e) => setDefSearch(e.target.value)}
              aria-label="Search workflow definitions"
            />
          </div>
        </div>
        <div className="wf-card-grid">
          {workflows.map((wf) => (
            <div key={wf.id} className="wf-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong>{wf.name}</strong>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {wf.paused && <StatusBadge status="paused" />}
                  <StatusBadge status={wf.status} />
                </div>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{wf.description || 'No description'}</p>
              <code style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                id: {wf.id}
              </code>
              <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                Triggers: {(wf.trigger_modes || ['manual']).join(', ')}
                {wf.schedule_cron ? ` · ${wf.schedule_cron}` : ''}
                {wf.chat_trigger_phrase ? ` · chat: "${wf.chat_trigger_phrase}"` : ''}
                {wf.paused && (
                  <span style={{ display: 'block', color: '#d97706', marginTop: 4 }}>
                    Paused — no new runs from schedule, chat, or Run button
                  </span>
                )}
              </div>
              <div className="wf-card-actions" style={{ flexWrap: 'wrap' }}>
                <Link to={`/workflows/${wf.id}/edit`} className="wf-btn">
                  Edit
                </Link>
                <button
                  type="button"
                  className="wf-btn"
                  disabled={busy === `export-${wf.id}`}
                  onClick={() => exportWorkflowJson(wf)}
                  title="Download workflow definition as JSON"
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  className="wf-btn-accent"
                  disabled={wf.status !== 'published' || wf.paused}
                  onClick={() => runWorkflow(wf)}
                  title={wf.paused ? 'Resume workflow to run' : undefined}
                >
                  Run
                </button>
                <button
                  type="button"
                  className="wf-btn"
                  disabled={busy === `wf-${wf.id}`}
                  onClick={() => togglePauseWorkflow(wf)}
                  title="Stop schedule/chat triggers and pause active runs for this workflow"
                >
                  {wf.paused ? 'Resume' : 'Pause triggers'}
                </button>
                {wf.status === 'published' && (
                  <button
                    type="button"
                    className="wf-btn"
                    disabled={busy === `trig-${wf.id}`}
                    onClick={() => setManualOnly(wf)}
                    title="Clear schedule/chat triggers immediately"
                  >
                    Manual only
                  </button>
                )}
                <button
                  type="button"
                  className="wf-btn wf-btn-danger"
                  disabled={busy === `del-wf-${wf.id}`}
                  onClick={() => deleteWorkflow(wf)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {!workflows.length && !loading && (
            <p className="wf-card-grid-empty" style={{ color: 'var(--muted)' }}>
              {defSearch.trim() ? 'No definitions match your search.' : 'No workflows yet. Create one to get started.'}
            </p>
          )}
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Run instances</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="wf-btn" disabled={!!busy} onClick={pauseAllRuns}>
              Pause all runs
            </button>
            <button type="button" className="wf-btn wf-btn-danger" disabled={!!busy} onClick={deleteAllRuns}>
              Delete all runs
            </button>
          </div>
        </div>
        <div className="wf-search-row">
          <input
            type="search"
            className="wf-search-input"
            placeholder="Search by workflow name, id, run #, or run id…"
            value={runSearch}
            onChange={(e) => setRunSearch(e.target.value)}
            aria-label="Search workflow runs"
          />
          {runsMeta.total > 0 && (
            <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
              {runsMeta.total} run{runsMeta.total === 1 ? '' : 's'}
              {runSearchDebounced.trim() ? ' matching' : ''}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: selectedRun ? '1fr 1fr' : '1fr', gap: '1rem', alignItems: 'start' }}>
          <div className="wf-runs-list">
            <table className="wf-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Trigger</th>
                <th>Started</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSearchParams({ run_id: String(r.id) })}
                  style={{ cursor: 'pointer', background: selectedRun?.id === r.id ? 'var(--surface)' : undefined }}
                >
                  <td>#{r.run_number}</td>
                  <td>
                    <div>{r.definition_name || r.definition_id}</div>
                    {r.definition_name && (
                      <code style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{r.definition_id}</code>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>{r.progress_pct ?? 0}%</td>
                  <td>{r.trigger}</td>
                  <td>{r.started_at ? formatLocalDateTime(r.started_at) : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {['running', 'pending'].includes(r.status) && (
                        <button
                          type="button"
                          className="wf-btn"
                          style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                          disabled={busy === `run-pause-${r.id}`}
                          onClick={(e) => pauseRun(r, e)}
                        >
                          Pause
                        </button>
                      )}
                      <button
                        type="button"
                        className="wf-btn wf-btn-danger"
                        style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                        disabled={busy === `run-del-${r.id}`}
                        onClick={(e) => deleteRun(r, e)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!runs.length && !loading && (
                <tr>
                  <td colSpan={7} style={{ color: 'var(--muted)', textAlign: 'center', padding: '1rem' }}>
                    {runSearchDebounced.trim() ? 'No runs match your search.' : 'No run instances yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {runsMeta.pages > 1 && (
            <div className="wf-pagination">
              <button
                type="button"
                className="wf-btn"
                disabled={runPage <= 1 || !!busy}
                onClick={() => setRunPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <span>
                Page {runsMeta.page} of {runsMeta.pages}
              </span>
              <button
                type="button"
                className="wf-btn"
                disabled={runPage >= runsMeta.pages || !!busy}
                onClick={() => setRunPage((p) => Math.min(runsMeta.pages, p + 1))}
              >
                Next
              </button>
            </div>
          )}
          </div>

          {selectedRun && (
            <div className="wf-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <h3 style={{ margin: 0 }}>
                  Run #{selectedRun.run_number} · {selectedRun.definition_name}
                </h3>
                <div style={{ display: 'flex', gap: 4 }}>
                  {['running', 'pending'].includes(selectedRun.status) && (
                    <button type="button" className="wf-btn" disabled={!!busy} onClick={() => pauseRun(selectedRun)}>
                      Pause run
                    </button>
                  )}
                  <button type="button" className="wf-btn wf-btn-danger" disabled={!!busy} onClick={() => deleteRun(selectedRun)}>
                    Delete run
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <StatusBadge status={selectedRun.status} />{' '}
                <span style={{ marginLeft: 8 }}>{selectedRun.progress_pct}%</span>
              </div>
              {selectedRun.error_message && (
                <p style={{ color: '#dc2626', fontSize: '0.85rem' }}>{selectedRun.error_message}</p>
              )}
              {listeningSteps.length > 0 && (
                <div className="wf-listen-active" style={{ marginTop: 8 }}>
                  <strong>SSE listen active</strong>
                  {listeningSteps.map((s) => (
                    <div key={s.node_id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                      <span style={{ fontSize: '0.85rem' }}>
                        {s.node_label || s.node_id} <StatusBadge status="listening" />
                      </span>
                      <button
                        type="button"
                        className="wf-btn wf-btn-danger"
                        disabled={!!busy}
                        onClick={(e) => stopListenStep(selectedRun, s.node_id, e)}
                      >
                        Stop listen
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <h4 style={{ marginTop: '1rem' }}>Steps <small style={{ fontWeight: 400, color: 'var(--muted)' }}>— hover for full I/O</small></h4>
              <ul className="wf-steps">
                {(selectedRun.steps || []).map((s) => (
                  <WorkflowStepTooltip key={s.id} step={s}>
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>
                          {s.node_label || s.node_id}
                          {(stepRepeatCounts[s.node_id] || 0) > 1 ? (
                            <small style={{ color: 'var(--muted)' }}> #{s.iteration ?? 1}</small>
                          ) : null}{' '}
                          <small>({s.node_type})</small>
                        </span>
                        <StatusBadge status={s.status} />
                      </div>
                      {s.input && (
                        <div className="wf-step-io">
                          <strong>Inputs:</strong> {summarizeStepIo(s.input, 'input')}
                        </div>
                      )}
                      {s.output && (
                        <div className="wf-step-io">
                          <strong>Outputs:</strong> {summarizeStepIo(s.output, 'output')}
                        </div>
                      )}
                      {s.error_message && <small style={{ color: '#dc2626' }}>{s.error_message}</small>}
                    </>
                  </WorkflowStepTooltip>
                ))}
              </ul>
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '1rem' }}>
                Agent tasks appear on the <Link to="/kanban">Kanban</Link> board.
              </p>
            </div>
          )}
        </div>
      </section>

      <WorkflowAgentChat
        onAgentEffects={(effects) => {
          if (effects.toast) showSuccess(effects.toast);
          if (effects.shouldRefreshList) refreshAll();
          if (effects.runInspected?.runId) loadRun(effects.runInspected.runId);
          else if (effects.runStarted?.runId) loadRun(effects.runStarted.runId);
        }}
      />
    </div>
  );
}
