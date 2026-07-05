import HoverFixedTooltip from './HoverFixedTooltip.jsx';

/** Hover tooltip showing full task title + description preview. */
export default function KanbanTaskTooltip({ task, children }) {
  if (!task) return children;

  const desc = (task.description || '').trim();
  const preview = desc.length > 600 ? `${desc.slice(0, 600)}…` : desc;

  const content = (
    <>
      <div className="kanban-task-tooltip-title">{task.title || '(no title)'}</div>
      {task.status && (
        <div className="kanban-task-tooltip-meta">Status: {task.status.replace(/_/g, ' ')}</div>
      )}
      {task.created_at && (
        <div className="kanban-task-tooltip-meta">Created: {new Date(task.created_at).toLocaleString()}</div>
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
