/** Normalize job-applicant / media API paths for authenticated fetch. */
export function normalizeApiPath(href) {
  if (!href || typeof href !== 'string') return '';
  const trimmed = href.trim();
  if (trimmed.startsWith('/api/')) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.pathname.startsWith('/api/')) return `${u.pathname}${u.search}`;
  } catch (_) {
    /* relative or invalid */
  }
  return trimmed;
}

export function isAuthenticatedApiPath(href) {
  const p = normalizeApiPath(href);
  return p.startsWith('/api/job-applicant/') || p.startsWith('/api/media/');
}
