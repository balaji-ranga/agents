import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { formatLocalDateTime } from '../utils/formatDateTime.js';

const STATUS_COLORS = {
  completed: '#16a34a',
  in_progress: '#2563eb',
  pending: 'var(--muted)',
  failed: '#dc2626',
  skipped: '#a3a3a3',
};

function StepBadge({ status }) {
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
      {status?.replace('_', ' ')}
    </span>
  );
}

function formatDt(iso) {
  if (!iso) return '—';
  return formatLocalDateTime(iso);
}

export default function JobWorkflows() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState(searchParams.get('profile_id') || '');
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .jobApplicantProfiles()
      .then((data) => {
        setProfiles(data.profiles || []);
        if (!profileId && data.active_profile_id) {
          setProfileId(data.active_profile_id);
        }
      })
      .catch(() => {});
  }, []);

  const loadRuns = useCallback(() => {
    if (!profileId) return;
    setLoading(true);
    setError(null);
    api
      .jobApplicantWorkflowList(profileId)
      .then((data) => setRuns(data.runs || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [profileId]);

  const loadWorkflow = useCallback(
    (workflowId) => {
      if (!workflowId) return;
      setLoading(true);
      setError(null);
      api
        .jobApplicantWorkflowGet(workflowId)
        .then((run) => {
          setSelected(run);
          setProfileId(run.profile_id);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    []
  );

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    const wfId = searchParams.get('workflow_id');
    if (wfId) loadWorkflow(Number(wfId));
  }, [searchParams, loadWorkflow]);

  const selectRun = (run) => {
    setSelected(null);
    setSearchParams({ profile_id: profileId, workflow_id: String(run.workflow_id) });
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Job search workflows</h1>
        <Link to="/kanban" style={{ fontSize: '0.85rem', color: 'var(--accent)' }}>
          ← Kanban
        </Link>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <label style={{ fontSize: '0.85rem' }}>
          Profile{' '}
          <select
            value={profileId}
            onChange={(e) => {
              setProfileId(e.target.value);
              setSelected(null);
              setSearchParams({ profile_id: e.target.value });
            }}
            style={{ marginLeft: 6, padding: '0.35rem 0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
          >
            <option value="">Select profile…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name || p.id} ({p.status})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={loadRuns}
          disabled={!profileId || loading}
          style={{ padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer' }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem', borderRadius: 8, background: '#fef2f2', color: '#b91c1c' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '280px 1fr' : '1fr', gap: '1.25rem' }}>
        <div>
          <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Runs {profileId ? `— ${profileId}` : ''}</h2>
          {!profileId && <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Select a profile to list workflow runs.</p>}
          {loading && !selected && <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Loading…</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {runs.map((run) => (
              <li key={run.workflow_id} style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  onClick={() => selectRun(run)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.65rem 0.75rem',
                    borderRadius: 8,
                    border: `1px solid ${selected?.workflow_id === run.workflow_id ? 'var(--accent)' : 'var(--border)'}`,
                    background: selected?.workflow_id === run.workflow_id ? 'rgba(124, 58, 237, 0.08)' : 'var(--surface)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>Workflow #{run.workflow_number}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 2 }}>
                    {run.status} · {run.progress?.percent ?? 0}% · {formatDt(run.started_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {profileId && !loading && runs.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>No workflow runs yet. Run discovery + job_run_workflow_now.</p>
          )}
        </div>

        {selected && (
          <div>
            <div
              style={{
                padding: '1rem',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                marginBottom: '1rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                    Workflow #{selected.workflow_number}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                    ID {selected.workflow_id} · {selected.profile_id} · {selected.workflow_goal}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: '0.85rem' }}>
                  <div>
                    Status: <strong>{selected.status}</strong>
                  </div>
                  <div>{selected.progress?.completed_steps}/{selected.progress?.total_steps} steps ({selected.progress?.percent}%)</div>
                  {selected.kanban_ceo_review_task_id && (
                    <Link to="/kanban" style={{ color: 'var(--accent)' }}>
                      Kanban task #{selected.kanban_ceo_review_task_id}
                    </Link>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 8, height: 6, background: 'var(--border)', borderRadius: 4 }}>
                <div
                  style={{
                    width: `${selected.progress?.percent || 0}%`,
                    height: '100%',
                    background: 'var(--accent)',
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>

            <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Steps</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: '1.25rem' }}>
              {(selected.steps || []).map((step) => (
                <div
                  key={step.step_key}
                  style={{
                    padding: '0.65rem 0.75rem',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      {step.step_order}. {step.step_label}
                    </div>
                    {(step.actor_type || step.started_at) && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 2 }}>
                        {step.actor_type && (
                          <span>
                            {step.actor_type}: {step.actor_id}
                          </span>
                        )}
                        {step.started_at && <span> · started {formatDt(step.started_at)}</span>}
                        {step.completed_at && <span> · done {formatDt(step.completed_at)}</span>}
                      </div>
                    )}
                  </div>
                  <StepBadge status={step.status} />
                </div>
              ))}
            </div>

            <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>Audit trail</h2>
            {(selected.audit_trail || []).length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>No events recorded yet.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                    <th style={{ padding: '0.5rem' }}>When</th>
                    <th style={{ padding: '0.5rem' }}>Step</th>
                    <th style={{ padding: '0.5rem' }}>Event</th>
                    <th style={{ padding: '0.5rem' }}>Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.audit_trail.map((ev, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>{formatDt(ev.at)}</td>
                      <td style={{ padding: '0.5rem' }}>{ev.step_label}</td>
                      <td style={{ padding: '0.5rem' }}>{ev.event}</td>
                      <td style={{ padding: '0.5rem' }}>
                        {ev.actor_type}: {ev.actor_id}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
