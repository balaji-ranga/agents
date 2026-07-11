import ChatMessageContent from './ChatMessageContent';
import { formatChatTimestamp } from '../utils/formatDateTime.js';

/**
 * Single chat bubble with role label and local timestamp.
 */
export default function ChatMessageRow({
  role,
  content,
  createdAt,
  roleLabel,
  className = '',
  style = {},
}) {
  const label = roleLabel || role;
  const isUser = role === 'user';
  return (
    <div
      className={className}
      style={{
        marginBottom: '0.75rem',
        padding: '0.75rem 1rem',
        background: isUser ? 'var(--border)' : 'transparent',
        borderRadius: 8,
        borderLeft: !isUser ? '3px solid var(--accent)' : 'none',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.35rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: isUser ? 'var(--text)' : 'var(--accent)' }}>
          {label}
        </span>
        {createdAt && (
          <time dateTime={createdAt} style={{ fontSize: '0.7rem', color: 'var(--muted)' }} title={createdAt}>
            {formatChatTimestamp(createdAt)}
          </time>
        )}
      </div>
      <ChatMessageContent content={content} />
    </div>
  );
}
