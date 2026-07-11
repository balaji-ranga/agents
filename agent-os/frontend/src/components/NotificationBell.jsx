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

function normalizeAgentNotification(n) {
  return {
    ...n,
    kind: 'agent',
    feedId: `agent-${n.id}`,
    sortAt: n.completed_at || n.scheduled_at || '',
  };
}

function normalizePlatformNotification(n) {
  return {
    ...n,
    kind: 'platform',
    feedId: `platform-${n.id}`,
    sortAt: n.created_at || '',
  };
}

function NotificationLink({ href, onNavigate, children }) {
  const url = String(href || '').trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) {
    return (
      <a href={url} target="_blank" rel="noreferrer" onClick={onNavigate} style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>
        {children}
      </a>
    );
  }
  return (
    <Link to={url.startsWith('/') ? url : `/${url}`} onClick={onNavigate} style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>
      {children}
    </Link>
  );
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

  const visible = notifications.filter((n) => !dismissedIds.includes(n.feedId));

  const persistDismissed = (ids) => {
    const next = Array.isArray(ids) ? ids.slice(-MAX_DISMISSED_IDS) : [];
    setDismissedIds(next);
    try {
      localStorage.setItem(NOTIFICATIONS_DISMISSED_KEY, JSON.stringify(next));
    } catch (_) {}
  };

  const clearAll = () => {
    const ids = notifications.map((n) => n.feedId).filter(Boolean);
    if (ids.length > 0) persistDismissed([...dismissedIds, ...ids]);
  };

  const fetchNotifications = () => {
    Promise.all([
      api.standupNotifications(20).catch(() => ({ notifications: [] })),
      api.platformNotifications(20).catch(() => ({ notifications: [] })),
    ]).then(([agentRes, platformRes]) => {
      const merged = [
        ...(agentRes.notifications || []).map(normalizeAgentNotification),
        ...(platformRes.notifications || []).map(normalizePlatformNotification),
      ].sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt)));
      setNotifications(merged);
    });
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

  const closePanel = () => setOpen(false);

  const panel =
    open && panelPos
      ? createPortal(
          <>
            <div className="notification-overlay-backdrop" aria-hidden onClick={closePanel} />
            <div
              className="notification-overlay-panel"
              role="dialog"
              aria-label="Notifications"
              style={{
                top: panelPos.top,
                left: panelPos.left,
                width: panelPos.width,
                maxHeight: PANEL_MAX_HEIGHT,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="notification-overlay-header">
                <span>Notifications</span>
                {visible.length > 0 && (
                  <button type="button" onClick={clearAll} className="notification-overlay-clear">
                    Clear
                  </button>
                )}
              </div>
              {visible.length === 0 ? (
                <div className="notification-overlay-empty">No notifications.</div>
              ) : (
                <div className="notification-overlay-list">
                  {visible.slice(0, 15).map((n) => (
                    <div key={n.feedId} className="notification-overlay-item">
                      {n.kind === 'platform' ? (
                        <>
                          <div style={{ marginBottom: '0.25rem' }}>
                            <strong>{n.title}</strong>
                            <span style={{ marginLeft: '0.35rem', fontSize: '0.75rem', color: 'var(--accent)' }}>
                              Admin
                            </span>
                          </div>
                          {n.body && <div className="notification-overlay-snippet">{n.body}</div>}
                          {n.link_url && (
                            <div style={{ marginTop: '0.35rem' }}>
                              <NotificationLink href={n.link_url} onNavigate={closePanel}>
                                Open →
                              </NotificationLink>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
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
                              <Link to="/kanban" onClick={closePanel} style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>
                                Kanban →
                              </Link>
                            )}
                            <Link
                              to={`/agents/${encodeURIComponent(n.to_agent_id)}/chat`}
                              onClick={closePanel}
                              style={{ color: 'var(--accent)', fontSize: '0.85rem' }}
                            >
                              Chat →
                            </Link>
                          </div>
                        </>
                      )}
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
        title="Notifications"
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
