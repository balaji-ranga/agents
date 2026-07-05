/**
 * Parse SQLite / ISO timestamps (stored as UTC without suffix) and format in server local time.
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

/** IANA timezone of the Node process (server local). */
export function getServerTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Format timestamp in server local time with timezone abbreviation (e.g. GMT+8). */
export function formatServerDateTime(value, opts = {}) {
  const d = parseApiDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...opts,
  }).format(d);
}
