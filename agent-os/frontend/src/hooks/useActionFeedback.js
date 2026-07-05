import { useState, useCallback, useRef, useEffect } from 'react';

/** Short-lived success/error banner for button actions. */
export function useActionFeedback(autoHideMs = 5000) {
  const [feedback, setFeedback] = useState(null);
  const timerRef = useRef(null);

  const clearFeedback = useCallback(() => {
    clearTimeout(timerRef.current);
    setFeedback(null);
  }, []);

  const show = useCallback(
    (type, message) => {
      if (!message) return;
      clearTimeout(timerRef.current);
      setFeedback({ type, message: String(message) });
      timerRef.current = setTimeout(() => setFeedback(null), autoHideMs);
    },
    [autoHideMs]
  );

  const showSuccess = useCallback((message) => show('success', message), [show]);
  const showError = useCallback((message) => show('error', message), [show]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { feedback, showSuccess, showError, clearFeedback };
}
