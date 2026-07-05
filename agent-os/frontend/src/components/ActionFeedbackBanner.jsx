/** Fixed toast-style banner for action success / failure. */
export default function ActionFeedbackBanner({ feedback, onDismiss }) {
  if (!feedback?.message) return null;
  const isSuccess = feedback.type === 'success';
  return (
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
}
