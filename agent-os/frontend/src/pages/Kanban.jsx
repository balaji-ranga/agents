import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { Link } from 'react-router-dom';
import KanbanTaskDescription, { isCeoJobReviewTask, parseCeoReviewContext } from '../components/KanbanTaskDescription.jsx';
import KanbanTaskArtifacts from '../components/KanbanTaskArtifacts.jsx';
import { formatLocalDateTime } from '../utils/formatDateTime.js';

const STATUSES = ['open', 'awaiting_confirmation', 'in_progress', 'completed', 'failed'];
const STATUS_LABELS = {
  open: 'Open',
  awaiting_confirmation: 'Awaiting confirmation',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
};

function isConfirmApprovalMessage(text) {
  const t = String(text || '').trim().toLowerCase();
  return /^(confirm|confirmed|yes|approve|approved|proceed|go ahead|ok|okay|accept|accepted)([.!]?)$/.test(t);
}

export default function Kanban() {
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [view, setView] = useState('weekly');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [taskDetail, setTaskDetail] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createAssignTo, setCreateAssignTo] = useState('coo');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [messageInput, setMessageInput] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [taskChatError, setTaskChatError] = useState(null);
  const [reopeningId, setReopeningId] = useState(null);
  const [draggingTask, setDraggingTask] = useState(null);
  const [dropTargetStatus, setDropTargetStatus] = useState(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [ceoReviewOnly, setCeoReviewOnly] = useState(false);
  const [approvingReview, setApprovingReview] = useState(false);
  const [approveError, setApproveError] = useState(null);
  const [approveSuccess, setApproveSuccess] = useState(null);
  const [reviewQueue, setReviewQueue] = useState(null);
  const [includingJobId, setIncludingJobId] = useState(null);
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const [drawerTab, setDrawerTab] = useState('details');
  const taskChatScrollRef = useRef(null);

  const toggleTaskSelection = (taskId, e) => {
    if (e) e.stopPropagation();
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };
  const selectAllTasks = (e) => {
    if (e) e.stopPropagation();
    if (selectedTaskIds.size === tasks.length) setSelectedTaskIds(new Set());
    else setSelectedTaskIds(new Set(tasks.map((t) => t.id)));
  };
  const deleteSelected = () => {
    if (selectedTaskIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedTaskIds.size} task(s)? This cannot be undone.`)) return;
    setDeleting(true);
    api.kanbanTasksDeleteBulk([...selectedTaskIds])
      .then(() => {
        setSelectedTaskIds(new Set());
        fetchTasks();
        if (selectedTask && selectedTaskIds.has(selectedTask.id)) setSelectedTask(null);
      })
      .catch((err) => setError(err.message || 'Delete failed'))
      .finally(() => setDeleting(false));
  };

  const fetchTasks = () => {
    const params = { view, limit: 300 };
    if (view === 'range') {
      if (rangeFrom) params.from = rangeFrom;
      if (rangeTo) params.to = rangeTo;
    }
    api.kanbanTasks(params).then((r) => setTasks(r.tasks || [])).catch(() => setTasks([]));
  };

  useEffect(() => {
    setLoading(true);
    api.agentsList().then(setAgents).catch(() => setAgents([]));
    fetchTasks();
    api.jobApplicantPipelineStatus().then(setPipelineStatus).catch(() => setPipelineStatus(null));
    setLoading(false);
  }, [view, rangeFrom, rangeTo]);

  useEffect(() => {
    if (!selectedTask) {
      setTaskDetail(null);
      setApproveError(null);
      setApproveSuccess(null);
      setDrawerTab('details');
      return;
    }
    setApproveError(null);
    setApproveSuccess(null);
    setReviewQueue(null);
    setDrawerTab('details');
    api.kanbanTaskGet(selectedTask.id).then(setTaskDetail).catch(() => setTaskDetail(null));
  }, [selectedTask?.id]);

  useEffect(() => {
    if (!taskDetail && !selectedTask) return;
    const desc = taskDetail?.description || selectedTask?.description || '';
    const isReview =
      (taskDetail?.status ?? selectedTask?.status) === 'awaiting_confirmation' &&
      isCeoJobReviewTask(taskDetail || selectedTask);
    if (!isReview) {
      setReviewQueue(null);
      return;
    }
    const { profileId, ceoUserId } = parseCeoReviewContext(desc);
    if (!profileId) return;
    api
      .jobApplicantReviewQueue(profileId, ceoUserId || 'default')
      .then(setReviewQueue)
      .catch(() => setReviewQueue(null));
  }, [taskDetail, selectedTask]);

  useEffect(() => {
    const el = taskChatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [taskDetail?.messages]);

  const totalCount = tasks.length;
  const ceoReviewTasks = tasks.filter(
    (t) => t.status === 'awaiting_confirmation' && isCeoJobReviewTask(t)
  );
  const displayTasks = ceoReviewOnly
    ? tasks.filter((t) => isCeoJobReviewTask(t))
    : tasks;
  const byAgentAndStatus = {};
  const agentIds = ['__unassigned__', ...agents.map((a) => a.id)];
  agentIds.forEach((aid) => {
    byAgentAndStatus[aid] = {};
    STATUSES.forEach((s) => (byAgentAndStatus[aid][s] = []));
  });
  displayTasks.forEach((t) => {
    const aid = t.assigned_agent_id || '__unassigned__';
    if (!byAgentAndStatus[aid]) {
      byAgentAndStatus[aid] = {};
      STATUSES.forEach((s) => (byAgentAndStatus[aid][s] = []));
    }
    if (!byAgentAndStatus[aid][t.status]) byAgentAndStatus[aid][t.status] = [];
    byAgentAndStatus[aid][t.status].push(t);
  });

  const agentName = (id) => {
    if (id === '__unassigned__') return 'Unassigned';
    const a = agents.find((x) => x.id === id);
    return a ? a.name : id;
  };

  const handleDragStart = (e, task) => {
    setDraggingTask(task);
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragEnd = () => {
    setDraggingTask(null);
    setDropTargetStatus(null);
  };
  const handleDragOver = (e, status) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetStatus(status);
  };
  const handleDragLeave = () => setDropTargetStatus(null);
  const handleDrop = (e, toStatus) => {
    e.preventDefault();
    setDropTargetStatus(null);
    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId || !toStatus) return;
    const task = tasks.find((t) => String(t.id) === taskId);
    if (!task || task.status === toStatus) return;
    api.kanbanTaskUpdate(Number(taskId), { status: toStatus })
      .then(() => { fetchTasks(); setDraggingTask(null); if (selectedTask?.id === Number(taskId)) setTaskDetail((d) => (d ? { ...d, status: toStatus } : d)); })
      .catch(() => {});
  };

  const handleCreate = () => {
    if (!createTitle.trim()) {
      setCreateError('Title required');
      return;
    }
    setCreateSubmitting(true);
    setCreateError(null);
    if (createAssignTo === 'coo') {
      api.standupsList(1)
        .then((standups) => {
          const standupId = standups[0]?.id;
          if (standupId) {
            return api.standupSendMessage(standupId, { content: createTitle.trim() });
          }
          return api.standupCreate({}).then((s) => api.standupSendMessage(s.id, { content: createTitle.trim() }));
        })
        .then(() => {
          setCreateOpen(false);
          setCreateTitle('');
          setCreateDesc('');
          setCreateAssignTo('coo');
          fetchTasks();
        })
        .catch((e) => setCreateError(e.message || 'Failed'))
        .finally(() => setCreateSubmitting(false));
    } else {
      api.kanbanTaskCreate({
        title: createTitle.trim(),
        description: createDesc.trim(),
        assign_to: createAssignTo,
      })
        .then(() => {
          setCreateOpen(false);
          setCreateTitle('');
          setCreateDesc('');
          setCreateAssignTo('coo');
          fetchTasks();
        })
        .catch((e) => setCreateError(e.message || 'Failed'))
        .finally(() => setCreateSubmitting(false));
    }
  };

  const approveJobReview = () => {
    const desc = taskDetail?.description || selectedTask?.description || '';
    const { profileId, ceoUserId, workflowId } = parseCeoReviewContext(desc);
    if (!profileId) {
      setApproveError('Could not find profile_id in task. Open a CEO Review task from job pipeline.');
      setApproveSuccess(null);
      return;
    }
    setApprovingReview(true);
    setApproveError(null);
    setApproveSuccess(null);
    const body = { profile_id: profileId, confirm: true };
    if (ceoUserId) body.ceo_user_id = ceoUserId;
    if (workflowId) body.workflow_id = workflowId;
    api
      .jobCeoReviewConfirm(body)
      .then((result) => {
        setApproveError(null);
        const msg =
          result?.message ||
          (result?.count > 0
            ? `Approved ${result.count} job(s). Application Agent task #${result.prefill_kanban?.kanban_task_id || 'queued'}.`
            : 'Review closed. No jobs were awaiting approval.');
        setApproveSuccess(msg);
        return api.kanbanTaskGet(selectedTask.id).then((detail) => ({ detail, result }));
      })
      .then(({ detail, result }) => {
        setTaskDetail(detail);
        fetchTasks();
        if (result?.count > 0 && result?.prefill_kanban?.kanban_task_id) {
          setTimeout(() => {
            setApproveSuccess(
              (prev) =>
                `${prev || ''} Prefill Kanban #${result.prefill_kanban.kanban_task_id} created under Application Agent.`
            );
          }, 0);
        } else if (result?.post_action === 'acknowledged') {
          setApproveSuccess(result.message || `Acknowledged ${result.count} job(s). Workflow complete.`);
        }
      })
      .catch((err) => {
        setApproveError(err?.message || 'Approve failed');
        setApproveSuccess(null);
      })
      .finally(() => setApprovingReview(false));
  };

  const includeBorderlineJob = (jobId) => {
    const desc = taskDetail?.description || selectedTask?.description || '';
    const { profileId, ceoUserId } = parseCeoReviewContext(desc);
    if (!profileId) return;
    setIncludingJobId(jobId);
    setApproveError(null);
    api
      .jobApplicantCeoReviewInclude(profileId, {
        job_ids: [jobId],
        ceo_user_id: ceoUserId || undefined,
      })
      .then((result) => {
        setApproveSuccess(
          result?.message ||
            `Included ${result?.included_count || 1} job(s) — now awaiting your approval.`
        );
        return Promise.all([
          api.jobApplicantReviewQueue(profileId, ceoUserId || 'default').then(setReviewQueue),
          selectedTask ? api.kanbanTaskGet(selectedTask.id).then(setTaskDetail) : Promise.resolve(),
        ]);
      })
      .then(() => fetchTasks())
      .catch((err) => setApproveError(err?.message || 'Include failed'))
      .finally(() => setIncludingJobId(null));
  };

  const sendMessage = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!messageInput.trim() || !selectedTask) return;

    const trimmed = messageInput.trim();
    const isCeoReview =
      (taskDetail?.status ?? selectedTask.status) === 'awaiting_confirmation' &&
      isCeoJobReviewTask(taskDetail || selectedTask);

    if (isCeoReview && isConfirmApprovalMessage(trimmed)) {
      setMessageInput('');
      approveJobReview();
      return;
    }

    setTaskChatError(null);
    setSendingMessage(true);
    api.kanbanTaskAddMessage(selectedTask.id, 'user', trimmed)
      .then(() => api.kanbanTaskGet(selectedTask.id))
      .then((detail) => {
        setTaskDetail(detail);
        setMessageInput('');
      })
      .catch((err) => {
        setTaskChatError(err?.message || 'Failed to send message');
      })
      .finally(() => setSendingMessage(false));
  };

  const reopenTask = (task) => {
    setReopeningId(task.id);
    api.kanbanTaskReopen(task.id)
      .then(() => {
        fetchTasks();
        if (selectedTask?.id === task.id) api.kanbanTaskGet(task.id).then(setTaskDetail);
      })
      .finally(() => setReopeningId(null));
  };

  const selectedIsCeoReview =
    selectedTask &&
    (taskDetail?.status ?? selectedTask.status) === 'awaiting_confirmation' &&
    isCeoJobReviewTask(taskDetail || selectedTask);

  const ceoReviewCtx = parseCeoReviewContext(taskDetail?.description || selectedTask?.description || '');
  const confirmIsApplication = ceoReviewCtx.requiresJobApplication !== false;

  return (
    <div style={{ padding: '1rem', maxWidth: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Kanban</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {['daily', 'weekly', 'monthly'].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              style={{
                padding: '0.35rem 0.75rem',
                border: `1px solid ${view === v ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6,
                background: view === v ? 'var(--accent)' : 'transparent',
                color: view === v ? 'white' : 'inherit',
                cursor: 'pointer',
              }}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
          <span style={{ marginLeft: '0.5rem' }}>Range:</span>
          <input
            type="date"
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value)}
            style={{ padding: '0.35rem', borderRadius: 6, border: '1px solid var(--border)' }}
          />
          <input
            type="date"
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value)}
            style={{ padding: '0.35rem', borderRadius: 6, border: '1px solid var(--border)' }}
          />
          <button type="button" onClick={() => { setView('range'); fetchTasks(); }} style={{ padding: '0.35rem 0.75rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer' }}>
            Apply
          </button>
        </div>
        <div style={{ flex: 1, minWidth: 120, maxWidth: 300 }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 2 }}>Total tasks</div>
          <div style={{ height: 8, background: 'var(--surface)', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: totalCount > 0 ? Math.min(100, (totalCount / 50) * 100) + '%' : 0,
                background: 'var(--accent)',
                borderRadius: 4,
              }}
            />
          </div>
          <span style={{ fontSize: '0.85rem' }}>{totalCount} tasks</span>
        </div>
        {selectedTaskIds.size > 0 && (
          <button
            type="button"
            onClick={deleteSelected}
            disabled={deleting}
            style={{ padding: '0.5rem 1rem', borderRadius: 6, background: 'var(--error, #dc2626)', color: 'white', border: 'none', cursor: 'pointer' }}
          >
            {deleting ? 'Deleting…' : `Delete selected (${selectedTaskIds.size})`}
          </button>
        )}
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          style={{ padding: '0.5rem 1rem', borderRadius: 6, background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 600 }}
        >
          + New task
        </button>
        <button
          type="button"
          onClick={() => setCeoReviewOnly((v) => !v)}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: 6,
            border: `1px solid ${ceoReviewOnly ? 'var(--accent)' : 'var(--border)'}`,
            background: ceoReviewOnly ? 'var(--accent)' : 'transparent',
            color: ceoReviewOnly ? 'white' : 'inherit',
            cursor: 'pointer',
          }}
        >
          Job applications {ceoReviewTasks.length > 0 ? `(${ceoReviewTasks.length})` : ''}
        </button>
      </div>

      {pipelineStatus?.job_counts && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1rem',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            fontSize: '0.85rem',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Job search pipeline
            {pipelineStatus.active_profile_id && (
              <>
                {' · '}
                <Link
                  to={`/job-workflows?profile_id=${encodeURIComponent(pipelineStatus.active_profile_id)}`}
                  style={{ color: 'var(--accent)', fontWeight: 500, fontSize: '0.85rem' }}
                >
                  View workflows
                </Link>
              </>
            )}
          </div>
          <div style={{ color: 'var(--muted)', marginBottom: 6 }}>
            Profile:{' '}
            <strong>
              {pipelineStatus.active_profile_display_name || pipelineStatus.active_profile_id || 'none'}
            </strong>
            {pipelineStatus.active_profile_id && pipelineStatus.active_profile_display_name !== pipelineStatus.active_profile_id && (
              <span style={{ fontSize: '0.8rem' }}> ({pipelineStatus.active_profile_id})</span>
            )}
            {pipelineStatus.profile_status ? ` · ${pipelineStatus.profile_status}` : ''}
            {' · '}
            {pipelineStatus.job_counts.discovered} discovered → {pipelineStatus.job_counts.shortlisted} shortlisted →{' '}
            {pipelineStatus.job_counts.awaiting_approval} awaiting your approval → {pipelineStatus.job_counts.approved} approved
          </div>
          {pipelineStatus.pending_pipeline_tasks && pipelineStatus.current_pipeline_stage && (
            <div style={{ color: 'var(--accent)', marginBottom: 6 }}>
              Running: <strong>{pipelineStatus.current_pipeline_stage}</strong>
              {pipelineStatus.current_pipeline_stage === 'discovery' && (
                <span style={{ color: 'var(--muted)' }}>
                  {' '}— Fit Scoring and Resume Tailoring start automatically when discovery finishes.
                </span>
              )}
            </div>
          )}
          {pipelineStatus.job_counts.discovered > 0 && pipelineStatus.job_counts.awaiting_approval === 0 && (
            <div style={{ color: '#b45309' }}>
              Jobs found but no Kanban review yet — ask Job Discovery to run <strong>job_run_workflow_now</strong> for this profile.
            </div>
          )}
          {ceoReviewTasks.length === 0 && pipelineStatus.job_counts.awaiting_approval > 0 && (
            <div style={{ color: '#b45309' }}>
              {pipelineStatus.job_counts.awaiting_approval} job(s) awaiting approval but no CEO review task — run workflow again from Job Discovery.
            </div>
          )}
        </div>
      )}

      {ceoReviewTasks.length > 0 && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '1rem',
            borderRadius: 8,
            border: '1px solid var(--accent)',
            background: 'rgba(124, 58, 237, 0.08)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
            Awaiting your confirmation — job applications ({ceoReviewTasks.length})
          </div>
          <p style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', color: 'var(--muted)' }}>
            Open a task below → use the green <strong>Approve applications</strong> button at the top of the panel,
            or type <strong>confirm</strong> in the task chat. Tasks live in the <strong>Awaiting confirmation</strong> column (usually under <strong>Unassigned</strong>).
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {ceoReviewTasks.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedTask(t)}
                style={{
                  textAlign: 'left',
                  padding: '0.65rem 0.85rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  cursor: 'pointer',
                  color: 'inherit',
                }}
              >
                <div style={{ fontWeight: 600 }}>{t.title}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 2 }}>
                  {formatLocalDateTime(t.created_at)} · Click to review jobs &amp; approve
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div style={{ color: 'var(--error)', marginBottom: '0.5rem' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--muted)' }}>Loading…</div>}

      <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
        <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', border: '1px solid var(--border)' }}>
          <thead>
            <tr>
              <th style={{ padding: '0.5rem', border: '1px solid var(--border)', background: 'var(--surface)', width: 44 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={tasks.length > 0 && selectedTaskIds.size === tasks.length}
                    onChange={selectAllTasks}
                    title="Select all"
                  />
                  <span style={{ fontSize: '0.75rem' }}>All</span>
                </label>
              </th>
              <th style={{ padding: '0.5rem', border: '1px solid var(--border)', background: 'var(--surface)', textAlign: 'left', minWidth: 120 }}>
                Agent
              </th>
              {STATUSES.map((s) => (
                <th key={s} style={{ padding: '0.5rem', border: '1px solid var(--border)', background: 'var(--surface)', minWidth: 140 }}>
                  {STATUS_LABELS[s]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agentIds.map((aid) => (
              <tr key={aid}>
                <td style={{ padding: '0.5rem', border: '1px solid var(--border)' }} />
                <td style={{ padding: '0.5rem', border: '1px solid var(--border)', fontWeight: 500 }}>{agentName(aid)}</td>
                {STATUSES.map((status) => (
                  <td
                    key={status}
                    onDragOver={(e) => handleDragOver(e, status)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, status)}
                    style={{
                      padding: '0.5rem',
                      border: '1px solid var(--border)',
                      verticalAlign: 'top',
                      minWidth: 140,
                      background: dropTargetStatus === status ? 'rgba(59, 130, 246, 0.1)' : undefined,
                    }}
                  >
                    {(byAgentAndStatus[aid]?.[status] || []).map((t) => (
                      <div
                        key={t.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, t)}
                        onDragEnd={handleDragEnd}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedTask(t)}
                        onKeyDown={(e) => e.key === 'Enter' && setSelectedTask(t)}
                        style={{
                          padding: '0.5rem',
                          marginBottom: '0.35rem',
                          background: draggingTask?.id === t.id ? 'var(--border)' : 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          cursor: draggingTask?.id === t.id ? 'grabbing' : 'grab',
                          fontSize: '0.9rem',
                          opacity: draggingTask?.id === t.id ? 0.8 : 1,
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.5rem',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedTaskIds.has(t.id)}
                          onChange={(e) => toggleTaskSelection(t.id, e)}
                          onClick={(e) => e.stopPropagation()}
                          title="Select task"
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500 }}>{t.title || '(no title)'}</div>
                          {isCeoJobReviewTask(t) && (
                            <span
                              style={{
                                display: 'inline-block',
                                marginTop: 4,
                                fontSize: '0.65rem',
                                padding: '2px 6px',
                                borderRadius: 4,
                                background: 'var(--accent)',
                                color: 'white',
                                fontWeight: 600,
                              }}
                            >
                              CEO JOB REVIEW
                            </span>
                          )}
                          {t.description && isCeoJobReviewTask(t) && (
                            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: 4, lineHeight: 1.3 }}>
                              {(t.description.match(/jobstreet\.com[^\s)]+/gi) || []).length > 0
                                ? `${(t.description.match(/###/g) || []).length || 'Multiple'} roles · JobStreet links inside`
                                : 'Open for shortlist & links'}
                            </div>
                          )}
                          {t.created_at && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 2 }}>
                              {formatLocalDateTime(t.created_at)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--bg)', padding: '1.5rem', borderRadius: 12, maxWidth: 440, width: '90%', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <h2 style={{ marginTop: 0 }}>New task</h2>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>Title *</label>
              <input
                type="text"
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder="Task title"
                style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
              />
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>Description</label>
              <textarea
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="Optional"
                rows={2}
                style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
              />
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>Assign to</label>
              <select
                value={createAssignTo}
                onChange={(e) => setCreateAssignTo(e.target.value)}
                style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
              >
                <option value="coo">COO (intent / delegate)</option>
                {agents.filter((a) => !a.is_coo).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            {createError && <div style={{ color: 'var(--error)', marginBottom: '0.5rem', fontSize: '0.9rem' }}>{createError}</div>}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setCreateOpen(false)} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button type="button" onClick={handleCreate} disabled={createSubmitting} style={{ padding: '0.5rem 1rem', borderRadius: 6, background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer' }}>
                {createSubmitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedTask && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', zIndex: 100 }}>
          <div
            style={{
              width: 'min(520px, 100%)',
              height: '100%',
              background: 'var(--bg)',
              boxShadow: '-4px 0 20px rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ flexShrink: 0, padding: '1rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.1rem' }}>{taskDetail?.title ?? selectedTask.title}</h2>
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                  {taskDetail?.assigned_agent_name || selectedTask.assigned_agent_name || 'Unassigned'} · {STATUS_LABELS[taskDetail?.status ?? selectedTask.status]}
                  {taskDetail?.artifact_count > 0 && (
                    <span> · {taskDetail.artifact_count} artifact{taskDetail.artifact_count === 1 ? '' : 's'}</span>
                  )}
                </div>
                {drawerTab === 'details' && selectedIsCeoReview && (
                  <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--accent)' }}>
                    Review job links & resumes below, then confirm to proceed with applications.
                  </div>
                )}
              </div>
              <button type="button" onClick={() => setSelectedTask(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem' }}>×</button>
            </div>
            <div
              style={{
                flexShrink: 0,
                display: 'flex',
                gap: 0,
                borderBottom: '1px solid var(--border)',
                padding: '0 0.75rem',
              }}
            >
              {[
                { id: 'details', label: 'Details' },
                { id: 'artifacts', label: `Artifacts${taskDetail?.artifact_count ? ` (${taskDetail.artifact_count})` : ''}` },
                { id: 'activity', label: 'Activity' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDrawerTab(tab.id)}
                  style={{
                    padding: '0.55rem 0.85rem',
                    border: 'none',
                    borderBottom: drawerTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                    background: 'transparent',
                    color: drawerTab === tab.id ? 'var(--accent)' : 'var(--muted)',
                    fontWeight: drawerTab === tab.id ? 600 : 500,
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div
              style={{
                flex: '1 1 0',
                minHeight: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
            <div
              ref={taskChatScrollRef}
              className="chat-scroll-panel"
              style={{ padding: '1rem', flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}
            >
            {drawerTab === 'details' && selectedIsCeoReview && (
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                  margin: '-1rem -1rem 1rem',
                  padding: '0.75rem 1rem',
                  borderBottom: '1px solid var(--accent)',
                  background: 'rgba(34, 197, 94, 0.1)',
                }}
              >
                {approveError && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--error, #dc2626)', marginBottom: 6 }}>{approveError}</div>
                )}
                {approveSuccess && (
                  <div
                    style={{
                      fontSize: '0.85rem',
                      color: '#166534',
                      marginBottom: 6,
                      padding: '0.5rem',
                      background: 'rgba(34, 197, 94, 0.15)',
                      borderRadius: 6,
                    }}
                  >
                    {approveSuccess}
                  </div>
                )}
                <button
                  type="button"
                  onClick={approveJobReview}
                  disabled={approvingReview}
                  style={{
                    width: '100%',
                    padding: '0.75rem 1rem',
                    borderRadius: 6,
                    background: '#16a34a',
                    color: 'white',
                    border: 'none',
                    cursor: approvingReview ? 'wait' : 'pointer',
                    fontWeight: 700,
                    fontSize: '0.95rem',
                  }}
                >
                  {approvingReview
                    ? 'Confirming…'
                    : confirmIsApplication
                      ? '✓ Approve applications — proceed with prefill'
                      : '✓ Acknowledge scoring summary — close workflow'}
                </button>
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', color: 'var(--muted)' }}>
                  Or type <strong>confirm</strong> in the message box below.
                  {!confirmIsApplication && ' Jobs will be marked acknowledged — no Application Agent.'}
                </p>
              </div>
            )}
            {drawerTab === 'details' && selectedIsCeoReview && reviewQueue?.borderline_jobs?.length > 0 && (
              <div
                style={{
                  marginBottom: '1rem',
                  padding: '0.75rem 1rem',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'rgba(234, 179, 8, 0.08)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 8 }}>
                  Below threshold ({reviewQueue.borderline?.min_score}%–{reviewQueue.fit_threshold - 1}%) — include selectively
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {reviewQueue.borderline_jobs.map((j) => (
                    <div
                      key={j.job_id}
                      style={{
                        padding: '0.5rem 0.65rem',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        fontSize: '0.85rem',
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {j.title || 'Untitled'} — {j.company || 'Unknown'} ({j.fit_score ?? '?'}%)
                      </div>
                      {j.fit_rationale && (
                        <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: '0.8rem' }}>{j.fit_rationale}</div>
                      )}
                      <button
                        type="button"
                        disabled={includingJobId === j.job_id}
                        onClick={() => includeBorderlineJob(j.job_id)}
                        style={{
                          marginTop: 6,
                          padding: '0.35rem 0.65rem',
                          borderRadius: 6,
                          border: 'none',
                          background: 'var(--accent)',
                          color: 'white',
                          cursor: 'pointer',
                          fontSize: '0.8rem',
                        }}
                      >
                        {includingJobId === j.job_id ? 'Including…' : 'Include in approval'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {drawerTab === 'artifacts' && (
              <KanbanTaskArtifacts artifacts={taskDetail?.artifacts || []} groups={taskDetail?.artifact_groups || []} />
            )}
            {drawerTab === 'details' && (taskDetail?.description || selectedTask.description) && (
                <div
                  style={{
                    marginBottom: '1rem',
                    padding: '0.85rem',
                    background: selectedIsCeoReview ? 'rgba(124, 58, 237, 0.06)' : 'var(--surface)',
                    borderRadius: 8,
                    border: `1px solid ${selectedIsCeoReview ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 8, fontWeight: 600 }}>
                    {selectedIsCeoReview ? 'Job application review (shortlist, portals, resumes)' : 'Task description'}
                  </div>
                  <KanbanTaskDescription description={taskDetail?.description || selectedTask.description} />
                </div>
              )}
            {drawerTab === 'activity' && taskDetail?.delegation_prompt && (
                <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Context given to agent</div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.85rem' }}>{taskDetail.delegation_prompt}</div>
                </div>
              )}
            {drawerTab === 'activity' && taskDetail?.delegation_response && (
                <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Agent response</div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.85rem' }}>{taskDetail.delegation_response}</div>
                </div>
              )}
            {drawerTab === 'activity' && (taskDetail?.messages || []).length > 0 && (
                <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 4, fontWeight: 600 }}>Task chat</div>
              )}
            {drawerTab === 'activity' && (taskDetail?.messages || []).map((m) => (
                <div key={m.id} style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 2 }}>{m.role}</div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.9rem' }}>{m.content}</div>
                </div>
              ))}
            </div>
            </div>
            <div style={{ flexShrink: 0, padding: '1rem', borderTop: '1px solid var(--border)' }}>
              <form onSubmit={sendMessage} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {taskChatError && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--error, #dc2626)' }}>{taskChatError}</div>
                )}
                <textarea
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder={selectedIsCeoReview ? 'Type confirm to approve, or add a note…' : 'Add message…'}
                  rows={2}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', resize: 'vertical' }}
                  disabled={sendingMessage}
                />
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button type="submit" disabled={sendingMessage || !messageInput.trim()} style={{ padding: '0.4rem 0.75rem', borderRadius: 6, background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer' }}>
                    {sendingMessage ? 'Sending…' : 'Send'}
                  </button>
                {selectedTask && (taskDetail?.status ?? selectedTask.status) !== 'open' && (
                  <button
                    type="button"
                    onClick={() => reopenTask(selectedTask)}
                    disabled={reopeningId === selectedTask.id}
                    style={{ padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer' }}
                  >
                    {reopeningId === selectedTask.id ? 'Reopening…' : 'Reopen task'}
                  </button>
                )}
                </div>
              </form>
            </div>
          </div>
          <div style={{ flex: 1 }} onClick={() => setSelectedTask(null)} aria-hidden />
        </div>
      )}
    </div>
  );
}
