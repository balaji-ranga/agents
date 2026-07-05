import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import ChatMessageContent from '../ChatMessageContent.jsx';

/**
 * Floating Workflow Builder chat — creates/edits workflows via prompt; syncs graph to editor.
 */
export default function WorkflowAgentChat({
  workflowId: initialWorkflowId = null,
  onGraphUpdated,
  onWorkflowCreated,
  onWorkflowMetaUpdated,
}) {
  const [open, setOpen] = useState(false);
  const [workflowId, setWorkflowId] = useState(initialWorkflowId);
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    setWorkflowId(initialWorkflowId);
  }, [initialWorkflowId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, sending, open]);

  const applyResponse = useCallback(
    (res) => {
      if (res.workflow_id && res.workflow_id !== workflowId) {
        setWorkflowId(res.workflow_id);
        onWorkflowCreated?.(res.workflow_id, res.workflow);
      }
      if (res.draft_graph && onGraphUpdated) {
        onGraphUpdated(res.draft_graph, res.workflow);
      }
      if (res.workflow && onWorkflowMetaUpdated) {
        onWorkflowMetaUpdated(res.workflow);
      }
    },
    [workflowId, onGraphUpdated, onWorkflowCreated, onWorkflowMetaUpdated]
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
    setTurns((prev) => [...prev, { role: 'user', content: msg }]);
    try {
      const res = await api.agentWorkflowAgentChat({
        message: msg,
        workflow_id: workflowId,
        history,
      });
      applyResponse(res);
      let assistantText = res.reply || '(no reply)';
      if (res.actions_applied?.length) {
        const summary = res.actions_applied
          .map((a) => `${a.action}${a.node_id ? `: ${a.node_id}` : ''}${a.workflow_id ? ` → ${a.workflow_id}` : ''}`)
          .join(', ');
        assistantText += `\n\n_Applied: ${summary}_`;
      }
      if (res.workflow_triggered) {
        assistantText += `\n\n▶ Run #${res.workflow_triggered.run_number} started.`;
      }
      setTurns((prev) => [...prev, { role: 'assistant', content: assistantText }]);
    } catch (err) {
      setError(err.message || 'Chat failed');
      setTurns((prev) => prev.slice(0, -1));
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
        <div className="wf-agent-panel">
          <header className="wf-agent-panel-header">
            <div>
              <strong>Workflow Builder</strong>
              <div className="wf-agent-panel-meta">
                {workflowId ? (
                  <>
                    Editing <code>{workflowId}</code>
                    {' · '}
                    <Link to={`/workflows/${workflowId}/edit`}>Open editor</Link>
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
            {turns.length === 0 && (
              <p className="wf-agent-hint">
                Try: &quot;Create a workflow: Brain summarizes input → CEO approval → if approved run Tech
                Researcher&quot;
                <br />
                Or: &quot;Add an email step after the agent with subject Daily update&quot;
                <br />
                Or: &quot;Run brain approval test&quot;
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`wf-agent-msg wf-agent-msg-${t.role}`}>
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
              placeholder="Describe workflow changes or ask to run a workflow…"
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
      )}
    </>
  );
}
