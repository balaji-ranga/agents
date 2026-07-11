import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../../api.js';
import ChatMessageContent from '../ChatMessageContent.jsx';
import { formatChatTimestamp } from '../../utils/formatDateTime.js';
import { deriveWorkflowAgentUiEffects } from '../../utils/workflowAgentUiEffects.js';

function chatStorageKey(workflowId) {
  return `wf-agent-chat:${workflowId || 'global'}`;
}

/**
 * Floating Workflow Builder chat — creates/edits/workflows via prompt; syncs graph to editor.
 * In editor: chat history persists while the panel is closed/reopened until leaving the page.
 */
export default function WorkflowAgentChat({
  workflowId: initialWorkflowId = null,
  onGraphUpdated,
  onWorkflowCreated,
  onWorkflowMetaUpdated,
  onAgentEffects,
  autoNavigate = true,
  onEditor = false,
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [workflowId, setWorkflowId] = useState(initialWorkflowId);
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    setWorkflowId(initialWorkflowId);
  }, [initialWorkflowId]);

  const loadHistory = useCallback(async (wfId) => {
    setLoadingHistory(true);
    try {
      const res = await api.agentWorkflowAgentChatHistory(wfId, 100);
      const serverTurns = (res.turns || []).map((t) => ({
        role: t.role,
        content: t.content,
        created_at: t.created_at,
      }));
      if (onEditor) {
        try {
          const cached = sessionStorage.getItem(chatStorageKey(wfId));
          if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > serverTurns.length) {
              setTurns(parsed);
              setError(null);
              return;
            }
          }
        } catch {
          /* use server */
        }
      }
      setTurns(serverTurns);
      setError(null);
    } catch {
      if (onEditor) {
        try {
          const cached = sessionStorage.getItem(chatStorageKey(wfId));
          if (cached) {
            setTurns(JSON.parse(cached));
            return;
          }
        } catch {
          /* fall through */
        }
      }
      setTurns([]);
    } finally {
      setLoadingHistory(false);
    }
  }, [onEditor]);

  // Load history when workflow context changes (not when panel opens/closes)
  useEffect(() => {
    loadHistory(workflowId);
  }, [workflowId, loadHistory]);

  // Persist editor chat to sessionStorage until page navigation
  useEffect(() => {
    if (!onEditor) return;
    try {
      sessionStorage.setItem(chatStorageKey(workflowId), JSON.stringify(turns));
    } catch {
      /* quota */
    }
  }, [turns, workflowId, onEditor]);

  useEffect(() => {
    if (!onEditor) return undefined;
    return () => {
      try {
        sessionStorage.removeItem(chatStorageKey(workflowId));
      } catch {
        /* ignore */
      }
    };
  }, [workflowId, onEditor]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, sending, open]);

  const runAutoNavigate = useCallback(
    (effects) => {
      if (!autoNavigate || !effects?.navigate) return;
      const { type, workflowId: wfId, runId } = effects.navigate;
      if (type === 'list') {
        navigate('/workflows');
        return;
      }
      if (type === 'editor' && wfId) {
        navigate(`/workflows/${wfId}/edit`);
        return;
      }
      if (type === 'run' && runId) {
        navigate(`/workflows?run_id=${runId}`);
      }
    },
    [autoNavigate, navigate]
  );

  const applyResponse = useCallback(
    async (res) => {
      const effectiveId = res.workflow_id || workflowId;
      const effects = deriveWorkflowAgentUiEffects(res, {
        currentWorkflowId: workflowId,
        onEditor,
      });

      if (res.workflow_id && res.workflow_id !== workflowId) {
        setWorkflowId(res.workflow_id);
        onWorkflowCreated?.(res.workflow_id, res.workflow);
      }

      let graph = res.draft_graph;
      let meta = res.workflow;

      if (effects.needsGraphRefresh && effectiveId && !graph) {
        try {
          const draft = await api.agentWorkflowDraftGet(effectiveId);
          graph = draft.draft_graph || graph;
          meta = {
            id: draft.workflow_id,
            name: draft.name,
            status: draft.status,
            paused: draft.paused,
            chat_trigger_phrase: draft.chat_trigger_phrase,
            ...(meta || {}),
          };
        } catch {
          /* keep response payload */
        }
      }

      if (graph && onGraphUpdated) {
        onGraphUpdated(graph, meta);
      } else if (meta && onWorkflowMetaUpdated) {
        onWorkflowMetaUpdated(meta);
      } else if (effects.lifecycleChanged && effectiveId && onWorkflowMetaUpdated) {
        try {
          const wf = await api.agentWorkflowGet(effectiveId);
          onWorkflowMetaUpdated({
            id: wf.id,
            name: wf.name,
            status: wf.status,
            paused: wf.paused,
            chat_trigger_phrase: wf.chat_trigger_phrase,
          });
        } catch {
          /* ignore */
        }
      }

      onAgentEffects?.(effects, res);
      runAutoNavigate(effects);
    },
    [
      workflowId,
      onGraphUpdated,
      onWorkflowCreated,
      onWorkflowMetaUpdated,
      onAgentEffects,
      onEditor,
      runAutoNavigate,
    ]
  );

  const pollDraft = useCallback(() => {
    if (!workflowId || !open) return;
    api
      .agentWorkflowDraftGet(workflowId)
      .then((draft) => {
        if (draft.draft_graph) {
          onGraphUpdated?.(draft.draft_graph, {
            id: draft.workflow_id,
            name: draft.name,
            status: draft.status,
            paused: draft.paused,
          });
        }
      })
      .catch(() => {});
  }, [workflowId, open, onGraphUpdated]);

  useEffect(() => {
    if (!open || !workflowId) return;
    const t = setInterval(pollDraft, 2500);
    return () => clearInterval(t);
  }, [open, workflowId, pollDraft]);

  const send = async (e) => {
    e?.preventDefault();
    if (!input.trim() || sending) return;

    const msg = input.trim();
    setInput('');
    setSending(true);
    setError(null);

    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((prev) => [...prev, { role: 'user', content: msg, created_at: new Date().toISOString() }]);

    try {
      const res = await api.agentWorkflowAgentChat({
        message: msg,
        workflow_id: workflowId,
        history,
      });
      await applyResponse(res);
      const assistantContent = res.reply || '(no reply)';
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', content: assistantContent, created_at: new Date().toISOString() },
      ]);
    } catch (err) {
      const errMsg = err.message || 'Chat failed';
      setError(errMsg);
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `**Error:** ${errMsg}`,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="wf-agent-fab"
        onClick={() => setOpen((o) => !o)}
        title="Workflow Builder agent"
        aria-label="Workflow Builder agent"
      >
        <span className="wf-agent-fab-icon" aria-hidden>
          ⚙
        </span>
        <span className="wf-agent-fab-label">Workflow Agent</span>
      </button>

      {open && (
        <>
          <div
            className="wf-agent-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div ref={panelRef} className="wf-agent-panel" role="dialog" aria-label="Workflow Builder chat">
            <header className="wf-agent-panel-header">
              <div>
                <strong>Workflow Builder</strong>
                <div className="wf-agent-panel-meta">
                  {workflowId ? (
                    <>
                      Editing <code>{workflowId}</code>
                      {!onEditor && (
                        <>
                          {' · '}
                          <Link to={`/workflows/${workflowId}/edit`}>Open editor</Link>
                        </>
                      )}
                    </>
                  ) : (
                    'Describe a workflow to create or edit'
                  )}
                </div>
              </div>
              <button type="button" className="wf-agent-close" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </header>

            {error && <div className="wf-agent-error">{error}</div>}

            <div ref={scrollRef} className="wf-agent-messages chat-scroll-panel">
              {loadingHistory && turns.length === 0 && (
                <p className="wf-agent-hint">Loading chat history…</p>
              )}
              {!loadingHistory && turns.length === 0 && (
                <p className="wf-agent-hint">
                  Try: &quot;Add a brain node with guardrails against sexual/abusive content and publish&quot;
                  <br />
                  &quot;Create a workflow: Brain summarizes input → CEO approval&quot;
                  <br />
                  &quot;explain brain node config&quot;
                  <br />
                  &quot;test brain approval&quot; · &quot;inspect run 3&quot;
                </p>
              )}
              {turns.map((t, i) => (
                <div key={i} className={`wf-agent-msg wf-agent-msg-${t.role}`}>
                  {t.created_at && (
                    <time
                      className="wf-agent-msg-time"
                      dateTime={t.created_at}
                      style={{ fontSize: '0.68rem', color: 'var(--muted)', display: 'block', marginBottom: 4 }}
                    >
                      {formatChatTimestamp(t.created_at)}
                    </time>
                  )}
                  <ChatMessageContent content={t.content} />
                </div>
              ))}
              {sending && <div className="wf-agent-msg wf-agent-msg-assistant wf-agent-thinking">Thinking…</div>}
            </div>

            <form className="wf-agent-input-row" onSubmit={send}>
              <textarea
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Edit workflow, run/test, pause, inspect runs, fix failures…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(e);
                  }
                }}
              />
              <button type="submit" className="wf-btn-primary" disabled={sending || !input.trim()}>
                Send
              </button>
            </form>
          </div>
        </>
      )}
    </>
  );
}
