import HoverFixedTooltip from './HoverFixedTooltip.jsx';
import { taskCreatedAtDisplay } from '../utils/formatDateTime.js';

/** Hover tooltip showing full task title + description preview. */
export default function KanbanTaskTooltip({ task, serverTimezone, children }) {
  if (!task) return children;

  const desc = (task.description || '').trim();
  const preview = desc.length > 600 ? `${desc.slice(0, 600)}…` : desc;
  const createdLabel = taskCreatedAtDisplay(task, serverTimezone);

  const content = (
    <>
      <div className="kanban-task-tooltip-title">{task.title || '(no title)'}</div>
      {task.status && (
        <div className="kanban-task-tooltip-meta">Status: {task.status.replace(/_/g, ' ')}</div>
      )}
      {createdLabel && createdLabel !== '—' && (
        <div className="kanban-task-tooltip-meta">Created: {createdLabel}</div>
      )}
      {preview ? (
        <pre className="kanban-task-tooltip-body">{preview}</pre>
      ) : (
        <div className="kanban-task-tooltip-meta">No description</div>
      )}
    </>
  );

  return (
    <HoverFixedTooltip
      className="kanban-task-wrap"
      tooltipClassName="kanban-task-tooltip"
      placement="auto"
      content={content}
    >
      {children}
    </HoverFixedTooltip>
  );
}
