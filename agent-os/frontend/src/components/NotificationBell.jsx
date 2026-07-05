import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api } from '../api';

const NOTIFICATIONS_DISMISSED_KEY = 'agent-os-dismissed-notification-ids';
const MAX_DISMISSED_IDS = 200;
const PANEL_WIDTH = 320;
const PANEL_MAX_HEIGHT = 360;

function computePanelPosition(buttonEl) {
  if (!buttonEl) return null;
  const rect = buttonEl.getBoundingClientRect();
  const margin = 8;
  let left = rect.left;
  const top = rect.bottom + 6;
  if (left + PANEL_WIDTH > window.innerWidth - margin) {
    left = window.innerWidth - PANEL_WIDTH - margin;
  }
  if (left < margin) left = margin;
  return { top, left, width: PANEL_WIDTH };
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState([]);
  const [dismissedIds, setDismissedIds] = useState(() => {
    try {
      const raw = localStorage.getItem(NOTIFICATIONS_DISMISSED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(-MAX_DISMISSED_IDS) : [];
    } catch (_) {
      return [];
    }
  });
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState(null);
  const buttonRef = useRef(null);

  const visible = notifications.filter((n) => !dismissedIds.includes(n.id));

  const persistDismissed = (ids) => {
    const next = Array.isArray(ids) ? ids.slice(-MAX_DISMISSED_IDS) : [];
    setDismissedIds(next);
    try {
      localStorage.setItem(NOTIFICATIONS_DISMISSED_KEY, JSON.stringify(next));
    } catch (_) {}
  };

  const clearAll = () => {
    const ids = notifications.map((n) => n.id).filter(Boolean);
    if (ids.length > 0) persistDismissed([...dismissedIds, ...ids]);
  };

  const fetchNotifications = () => {
    api.standupNotifications(20).then((data) => setNotifications(data.notifications || [])).catch(() => setNotifications([]));
  };

  const updatePanelPosition = useCallback(() => {
    setPanelPos(computePanelPosition(buttonRef.current));
  }, []);

  const toggleOpen = (e) => {
    e.stopPropagation();
    setOpen((wasOpen) => {
      if (wasOpen) return false;
      setPanelPos(computePanelPosition(buttonRef.current));
      return true;
    });
  };

  useEffect(() => {
    fetchNotifications();
    const id = setInterval(fetchNotifications, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    updatePanelPosition();
    const onScrollOrResize = () => updatePanelPosition();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };

    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, updatePanelPosition]);

  const panel =
    open && panelPos
      ? createPortal(
          <>
            <div
              className="notification-overlay-backdrop"
              aria-hidden
              onClick={() => setOpen(false)}
            />
            <div
              className="notification-overlay-panel"
              role="dialog"
              aria-label="Agent responses"
              style={{
                top: panelPos.top,
                left: panelPos.left,
                width: panelPos.width,
                maxHeight: PANEL_MAX_HEIGHT,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="notification-overlay-header">
                <span>Agent responses</span>
                {visible.length > 0 && (
                  <button type="button" onClick={clearAll} className="notification-overlay-clear">
                    Clear
                  </button>
                )}
              </div>
              {visible.length === 0 ? (
                <div className="notification-overlay-empty">No recent responses.</div>
              ) : (
                <div className="notification-overlay-list">
                  {visible.slice(0, 15).map((n) => (
                    <div key={n.id} className="notification-overlay-item">
                      <div style={{ marginBottom: '0.25rem' }}>
                        <strong>{n.agent_name || n.to_agent_id}</strong>
                        {n.is_job_pipeline && (
                          <span style={{ marginLeft: '0.35rem', fontSize: '0.75rem', color: 'var(--accent)' }}>
                            Job pipeline
                          </span>
                        )}
                        {' — '}
                        {n.standup_title || new Date(n.scheduled_at).toLocaleDateString()}
                      </div>
                      {n.response_snippet && (
                        <div className="notification-overlay-snippet">{n.response_snippet}…</div>
                      )}
                      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        {n.kanban_task_id && (
                          <Link to="/kanban" onClick={() => setOpen(false)} style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>
                            Kanban →
                          </Link>
                        )}
                        <Link
                          to={`/agents/${encodeURIComponent(n.to_agent_id)}/chat`}
                          onClick={() => setOpen(false)}
                          style={{ color: 'var(--accent)', fontSize: '0.85rem' }}
                        >
                          Chat →
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        title="Agent responses"
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{
          padding: '0.4rem 0.6rem',
          background: visible.length ? 'var(--accent)' : 'var(--surface)',
          color: visible.length ? '#fff' : 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          cursor: 'pointer',
          fontSize: '0.9rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
          width: '100%',
          justifyContent: 'center',
        }}
      >
        <span aria-hidden>🔔</span>
        {visible.length > 0 && <span style={{ fontSize: '0.8rem', opacity: 0.9 }}>{visible.length}</span>}
      </button>
      {panel}
    </>
  );
}
