import { useState, useEffect } from 'react';
import KanbanTaskTooltip from './KanbanTaskTooltip.jsx';
import { isCeoJobReviewTask, isWorkflowCeoApprovalTask } from './KanbanTaskDescription.jsx';
import { parseApiDate } from '../utils/formatDateTime.js';

const PAGE_SIZE = 5;

function sortTasksNewestFirst(tasks) {
  return [...tasks].sort((a, b) => {
    const ta = parseApiDate(a.created_at)?.getTime() ?? 0;
    const tb = parseApiDate(b.created_at)?.getTime() ?? 0;
    return tb - ta;
  });
}

export default function KanbanBoardCell({
  cellKey,
  tasks,
  serverTimezone,
  draggingTask,
  selectedTaskIds,
  onSelectTask,
  onToggleSelection,
  onDragStart,
  onDragEnd,
}) {
  const [page, setPage] = useState(0);
  const sorted = sortTasksNewestFirst(tasks);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const visible = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [cellKey]);

  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  return (
    <>
      {visible.map((t) => (
        <KanbanTaskTooltip key={t.id} task={t} serverTimezone={serverTimezone}>
          <div
            draggable
            onDragStart={(e) => onDragStart(e, t)}
            onDragEnd={onDragEnd}
            role="button"
            tabIndex={0}
            onClick={() => onSelectTask(t)}
            onKeyDown={(e) => e.key === 'Enter' && onSelectTask(t)}
            className="kanban-card-compact"
            style={{
              background: draggingTask?.id === t.id ? 'var(--border)' : undefined,
              cursor: draggingTask?.id === t.id ? 'grabbing' : 'grab',
              opacity: draggingTask?.id === t.id ? 0.8 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={selectedTaskIds.has(t.id)}
              onChange={(e) => onToggleSelection(t.id, e)}
              onClick={(e) => e.stopPropagation()}
              title="Select task"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="kanban-card-title">{t.title || '(no title)'}</div>
              {isWorkflowCeoApprovalTask(t) && (
                <span style={{ fontSize: '0.6rem', color: '#ca8a04', fontWeight: 700 }}>WF CEO</span>
              )}
              {isCeoJobReviewTask(t) && (
                <span style={{ fontSize: '0.6rem', color: 'var(--accent)', fontWeight: 700 }}>CEO</span>
              )}
            </div>
          </div>
        </KanbanTaskTooltip>
      ))}
      {sorted.length > PAGE_SIZE && (
        <div className="kanban-cell-pagination">
          <button
            type="button"
            className="kanban-cell-pagination-btn"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Previous tasks"
          >
            ‹
          </button>
          <span className="kanban-cell-pagination-label">
            {safePage + 1}/{totalPages}
            <span className="kanban-cell-pagination-count"> ({sorted.length})</span>
          </span>
          <button
            type="button"
            className="kanban-cell-pagination-btn"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            aria-label="Next tasks"
          >
            ›
          </button>
        </div>
      )}
    </>
  );
}
