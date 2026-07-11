/** Fixed toast-style banner for action success / failure. Renders via portal so it stays visible over the workflow editor. */
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';

export default function ActionFeedbackBanner({ feedback, onDismiss }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !feedback?.message) return null;

  const isSuccess = feedback.type === 'success';
  const node = (
    <div
      className={`action-feedback action-feedback--${isSuccess ? 'success' : 'error'}`}
      role="status"
      aria-live="polite"
    >
      <span className="action-feedback-icon" aria-hidden>
        {isSuccess ? '✓' : '✕'}
      </span>
      <span className="action-feedback-text">{feedback.message}</span>
      {onDismiss && (
        <button type="button" className="action-feedback-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );

  return createPortal(node, document.body);
}
