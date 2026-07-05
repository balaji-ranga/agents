/**
 * Renders Kanban task description (markdown-lite: headers, links, lists).
 */
import AuthenticatedApiLink from './AuthenticatedApiLink.jsx';
import { isAuthenticatedApiPath, normalizeApiPath } from '../utils/authenticatedApiUrl';
function TaskLink({ href, label }) {
  if (isAuthenticatedApiPath(href)) {
    return <AuthenticatedApiLink href={normalizeApiPath(href)}>{label}</AuthenticatedApiLink>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
      {label}
    </a>
  );
}

function linkifyLine(line) {
  const parts = [];
  let rest = line;
  const mdLink = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  while ((m = mdLink.exec(line)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: line.slice(last, m.index) });
    parts.push({ type: 'link', label: m[1], href: m[2] });
    last = m.index + m[0].length;
  }
  if (last < line.length) rest = line.slice(last);
  else rest = '';

  if (parts.length === 0) {
    const urlRe = /(https?:\/\/[^\s<>"']+)/g;
    let idx = 0;
    let um;
    while ((um = urlRe.exec(line)) !== null) {
      if (um.index > idx) parts.push({ type: 'text', value: line.slice(idx, um.index) });
      parts.push({ type: 'link', label: um[1], href: um[1] });
      idx = um.index + um[0].length;
    }
    if (idx < line.length) parts.push({ type: 'text', value: line.slice(idx) });
    if (parts.length === 0) parts.push({ type: 'text', value: line });
    return parts;
  }

  if (rest) {
    const urlRe = /(https?:\/\/[^\s<>"']+)/g;
    let idx = 0;
    let um;
    while ((um = urlRe.exec(rest)) !== null) {
      if (um.index > idx) parts.push({ type: 'text', value: rest.slice(idx, um.index) });
      parts.push({ type: 'link', label: um[1], href: um[1] });
      idx = um.index + um[0].length;
    }
    if (idx < rest.length) parts.push({ type: 'text', value: rest.slice(idx) });
  }
  return parts;
}

export function isWorkflowCeoApprovalTask(task) {
  return String(task?.description || '').includes('node_type: ceo_approval');
}

export function isCeoJobReviewTask(task) {
  const desc = task?.description || '';
  const title = task?.title || '';
  return (
    desc.includes('await_confirmation_to_apply') ||
    desc.includes('ceo_review_profile:') ||
    title.includes('Confirm applications') ||
    title.startsWith('CEO Review:')
  );
}

export function parseProfileIdFromDescription(description) {
  const text = String(description || '');
  const m = text.match(/ceo_review_profile:([^\s\n]+)/);
  if (m) return m[1].trim();
  const line = text.match(/profile_id:\s*`?([^`\s\n]+)`?/);
  return line ? line[1].trim() : null;
}

export function parseCeoReviewContext(description) {
  const text = String(description || '');
  const ceoMatch = text.match(/ceo_user_id:\s*(\S+)/);
  const goalMatch = text.match(/workflow_goal:\s*(\S+)/);
  const wfIdMatch = text.match(/workflow_id:\s*(\d+)/);
  const wfNumMatch = text.match(/workflow_number:\s*(\d+)/);
  const goal = goalMatch ? goalMatch[1].trim() : null;
  return {
    profileId: parseProfileIdFromDescription(text),
    ceoUserId: ceoMatch ? ceoMatch[1].trim() : null,
    workflowGoal: goal,
    workflowId: wfIdMatch ? Number(wfIdMatch[1]) : null,
    workflowNumber: wfNumMatch ? Number(wfNumMatch[1]) : null,
    requiresJobApplication: goal !== 'scoring_summary',
  };
}

export default function KanbanTaskDescription({ description, compact = false }) {
  if (!description || !String(description).trim()) {
    return (
      <p style={{ fontSize: '0.85rem', color: 'var(--muted)', fontStyle: 'italic', margin: 0 }}>
        No description for this task.
      </p>
    );
  }

  const lines = String(description).split(/\r?\n/);

  return (
    <div
      className="kanban-task-description"
      style={{
        fontSize: compact ? '0.8rem' : '0.9rem',
        lineHeight: 1.55,
        wordBreak: 'break-word',
      }}
    >
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} style={{ height: '0.4rem' }} />;

        if (trimmed.startsWith('## ')) {
          return (
            <h3
              key={i}
              style={{
                margin: compact ? '0.5rem 0 0.25rem' : '0.75rem 0 0.35rem',
                fontSize: compact ? '0.85rem' : '0.95rem',
                fontWeight: 600,
                color: 'var(--text)',
              }}
            >
              {trimmed.slice(3)}
            </h3>
          );
        }

        if (trimmed.startsWith('### ')) {
          return (
            <h4 key={i} style={{ margin: '0.5rem 0 0.2rem', fontSize: '0.88rem', fontWeight: 600 }}>
              {trimmed.slice(4)}
            </h4>
          );
        }

        if (trimmed.startsWith('- ')) {
          const content = trimmed.slice(2);
          const boldMatch = content.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
          const parts = linkifyLine(boldMatch ? boldMatch[2] : content);
          return (
            <div key={i} style={{ marginLeft: '0.75rem', marginBottom: '0.2rem', display: 'flex', gap: '0.35rem' }}>
              <span style={{ color: 'var(--muted)' }}>•</span>
              <span>
                {boldMatch && <strong>{boldMatch[1]}: </strong>}
                {parts.map((p, j) =>
                  p.type === 'link' ? (
                    <TaskLink key={j} href={p.href} label={p.label} />
                  ) : (
                    <span key={j}>{p.value}</span>
                  )
                )}
              </span>
            </div>
          );
        }

        if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
          return (
            <p key={i} style={{ margin: '0.35rem 0', fontWeight: 600 }}>
              {trimmed.slice(2, -2)}
            </p>
          );
        }

        const parts = linkifyLine(trimmed);
        return (
          <p key={i} style={{ margin: '0.25rem 0' }}>
            {parts.map((p, j) =>
              p.type === 'link' ? (
                <TaskLink key={j} href={p.href} label={p.label} />
              ) : (
                <span key={j}>{p.value}</span>
              )
            )}
          </p>
        );
      })}
    </div>
  );
}
