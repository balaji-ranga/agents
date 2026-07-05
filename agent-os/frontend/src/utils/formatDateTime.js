/**
 * Parse SQLite / ISO timestamps as UTC and format in the user's local timezone.
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

export function formatLocalDateTime(value, opts = {}) {
  const d = parseApiDate(value);
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    dateStyle: opts.dateStyle ?? 'medium',
    timeStyle: opts.timeStyle ?? 'short',
    ...opts,
  });
}
