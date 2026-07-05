import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { formatLocalDateTime } from '../utils/formatDateTime.js';
import { api } from '../api.js';
import WorkflowStepTooltip from '../components/WorkflowStepTooltip.jsx';
import { summarizeStepIo } from '../utils/workflowStepIo.js';
import ActionFeedbackBanner from '../components/ActionFeedbackBanner.jsx';
import { useActionFeedback } from '../hooks/useActionFeedback.js';
import WorkflowAgentChat from '../components/workflow/WorkflowAgentChat.jsx';

const STATUS_COLORS = {
  completed: '#16a34a',
  running: '#2563eb',
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
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const { feedback, showSuccess, showError, clearFeedback } = useActionFeedback();
  const [newName, setNewName] = useState('');
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.agentWorkflowList(), api.agentWorkflowRuns(), api.agentWorkflowTemplates()])
      .then(([wfRes, runsRes, tplRes]) => {
        setWorkflows(wfRes.workflows || []);
        setRuns(runsRes.runs || []);
        setTemplates(tplRes.templates || []);
      })
      .catch((e) => showError(e.message || 'Failed to load workflows'))
      .finally(() => setLoading(false));
  }, [showError]);

  useEffect(() => {
    load();
  }, [load]);

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
    if (!selectedRun || selectedRun.status !== 'running') return;
    const t = setInterval(() => loadRun(selectedRun.id), 5000);
    return () => clearInterval(t);
  }, [selectedRun?.id, selectedRun?.status, loadRun]);

  const withBusy = async (key, fn, successMessage) => {
    setBusy(key);
    try {
      const result = await fn();
      if (successMessage) showSuccess(successMessage);
      load();
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

  const runWorkflow = async (wf) => {
    try {
      const run = await api.agentWorkflowRun(wf.id, { input: '' });
      setSearchParams({ run_id: String(run.id) });
      showSuccess(`Run #${run.run_number} started for "${wf.name}"`);
      load();
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
    <div className="page workflows-page" style={{ padding: '1.5rem', maxWidth: 1200 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Workflows</h1>
          <p style={{ color: 'var(--muted)', margin: '0.5rem 0 0' }}>
            Design, publish, and run custom agent workflows (separate from Job workflows).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
        </div>
      </header>

      <ActionFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}

      <section style={{ marginBottom: '2rem' }}>
        <h2>Definitions</h2>
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
            <p style={{ color: 'var(--muted)' }}>No workflows yet. Create one to get started.</p>
          )}
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Recent runs</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="wf-btn" disabled={!!busy} onClick={pauseAllRuns}>
              Pause all runs
            </button>
            <button type="button" className="wf-btn wf-btn-danger" disabled={!!busy} onClick={deleteAllRuns}>
              Delete all runs
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: selectedRun ? '1fr 1fr' : '1fr', gap: '1rem' }}>
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
                  <td>{r.definition_name || r.definition_id}</td>
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
            </tbody>
          </table>

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
              <h4 style={{ marginTop: '1rem' }}>Steps <small style={{ fontWeight: 400, color: 'var(--muted)' }}>— hover for full I/O</small></h4>
              <ul className="wf-steps">
                {(selectedRun.steps || []).map((s) => (
                  <WorkflowStepTooltip key={s.id} step={s}>
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>
                          {s.node_label || s.node_id} <small>({s.node_type})</small>
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
        onWorkflowCreated={(id) => {
          load();
          navigate(`/workflows/${id}/edit`);
        }}
      />
    </div>
  );
}
