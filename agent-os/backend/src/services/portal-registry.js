/**
 * Known job portals registry (login URLs, default search templates).
 */
export const PORTAL_REGISTRY = {
  'linkedin.com': {
    label: 'LinkedIn',
    login_url: 'https://www.linkedin.com/login',
    search_url_template: 'https://www.linkedin.com/jobs/search/?keywords={q}&location={loc}',
    requires_login: true,
  },
  linkedin: {
    label: 'LinkedIn',
    login_url: 'https://www.linkedin.com/login',
    requires_login: true,
  },
  'jobstreet.com.sg': {
    label: 'JobStreet Singapore',
    login_url: 'https://www.jobstreet.com.sg/login',
    search_url_template: 'https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}',
    requires_login: true,
  },
  'jobstreet.com': {
    label: 'JobStreet',
    login_url: 'https://www.jobstreet.com/login',
    search_url_template: 'https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}',
    requires_login: true,
  },
  'mycareersfuture.gov.sg': {
    label: 'MyCareersFuture',
    login_url: 'https://www.mycareersfuture.gov.sg/',
    requires_login: true,
  },
};

export function normalizePortalKey(source) {
  const s = String(source || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (PORTAL_REGISTRY[s]) return s;
  if (s.includes('linkedin')) return 'linkedin.com';
  if (s.includes('jobstreet')) return 'jobstreet.com.sg';
  if (s.includes('mycareersfuture')) return 'mycareersfuture.gov.sg';
  return s;
}

export function portalInfo(source) {
  const key = normalizePortalKey(source);
  const reg = PORTAL_REGISTRY[key];
  if (reg) return { key, ...reg };
  const loginUrl = source.startsWith('http') ? source : `https://${source}`;
  return {
    key,
    label: key,
    login_url: loginUrl,
    requires_login: true,
  };
}

export function portalsFromProfileSources(sources = []) {
  const list = Array.isArray(sources) ? sources : [sources];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const info = portalInfo(s);
    if (!seen.has(info.key)) {
      seen.add(info.key);
      out.push(info);
    }
  }
  return out;
}
