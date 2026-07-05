/**
 * Parse SQLite / ISO timestamps (stored as UTC without suffix).
 */
export function parseApiDate(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !s.includes('T')) {
    s = `${s.replace(' ', 'T')}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ+]/.test(s.slice(-6))) {
    s = `${s}Z`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format timestamp with timezone abbreviation.
 * Pass timeZone (IANA, from API server_timezone) for server local time.
 */
export function formatServerDateTime(value, timeZone, opts = {}) {
  const d = parseApiDate(value);
  if (!d) return '—';
  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...opts,
  };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat(undefined, options).format(d);
}

/** @param {object} [opts] - may include timeZone (server IANA) */
export function formatLocalDateTime(value, opts = {}) {
  const { timeZone, ...rest } = opts;
  return formatServerDateTime(value, timeZone, rest);
}

/** Prefer API pre-formatted created_at_display when present. */
export function taskCreatedAtDisplay(task, timeZone) {
  if (task?.created_at_display) return task.created_at_display;
  return formatServerDateTime(task?.created_at, timeZone);
}
