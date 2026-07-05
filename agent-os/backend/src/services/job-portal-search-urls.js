/**
 * Profile-bound job portal search URL patterns for Job Discovery.
 *
 * Placeholders:
 *   {q}             — URL-encoded title (query-param style)
 *   {loc}           — URL-encoded location
 *   {title}         — raw title
 *   {location}      — raw location
 *   {title_slug}    — path slug for title (e.g. SVP-head-of-tech)
 *   {location_slug} — path slug for location (e.g. Singapore)
 */
import { portalsFromProfileSources, normalizePortalKey } from './portal-registry.js';

export const PORTAL_SEARCH_PATTERN_HELP =
  'Placeholders: {q}, {loc}, {title}, {location}, {title_slug}, {location_slug}';

export const DEFAULT_PORTAL_SEARCH_PATTERNS = {
  'linkedin.com':
    'https://www.linkedin.com/jobs/search/?keywords={q}&location={loc}',
  linkedin: 'https://www.linkedin.com/jobs/search/?keywords={q}&location={loc}',
  'jobstreet.com.sg': 'https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}',
  'jobstreet.com': 'https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}',
  jobstreet: 'https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}',
};

function encQuery(s) {
  return encodeURIComponent(String(s || '').trim());
}

/** JobStreet-style title slug: SVP Head of Tech → SVP-head-of-tech */
export function slugifyTitleForPath(title) {
  return String(title || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return word.toLowerCase();
    })
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '');
}

/** JobStreet-style location slug: Singapore → Singapore, New York → New-York */
export function slugifyLocationForPath(location) {
  return String(location || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '');
}

export function applySearchUrlPattern(template, { title = '', location = '' } = {}) {
  const t = String(title || '').trim();
  const loc = String(location || '').trim();
  return String(template || '')
    .replace(/\{q\}/g, encQuery(t))
    .replace(/\{loc\}/g, encQuery(loc))
    .replace(/\{title\}/g, t)
    .replace(/\{location\}/g, loc)
    .replace(/\{title_slug\}/g, slugifyTitleForPath(t))
    .replace(/\{location_slug\}/g, slugifyLocationForPath(loc));
}

export function getPortalSearchPatterns(intake = {}) {
  const fromIntake =
    intake.portal_search_patterns && typeof intake.portal_search_patterns === 'object'
      ? { ...intake.portal_search_patterns }
      : {};

  if (intake.linkedin_search_url_pattern) {
    fromIntake['linkedin.com'] = String(intake.linkedin_search_url_pattern).trim();
  }
  if (intake.jobstreet_search_url_pattern) {
    fromIntake['jobstreet.com.sg'] = String(intake.jobstreet_search_url_pattern).trim();
  }

  return { ...DEFAULT_PORTAL_SEARCH_PATTERNS, ...fromIntake };
}

export function patternForPortalKey(portalKey, patterns = {}) {
  if (patterns[portalKey]) return patterns[portalKey];
  if (portalKey.includes('linkedin')) {
    return patterns['linkedin.com'] || patterns.linkedin || null;
  }
  if (portalKey.includes('jobstreet')) {
    return patterns['jobstreet.com.sg'] || patterns.jobstreet || null;
  }
  return patterns[portalKey] || null;
}

/** Pre-built filtered job search URLs from profile intake (LinkedIn + JobStreet + custom patterns). */
export function buildDiscoverySearchUrls(intake = {}) {
  const titles = (Array.isArray(intake.target_titles) ? intake.target_titles : []).filter(Boolean);
  const locations = (Array.isArray(intake.locations) ? intake.locations : []).filter(Boolean);
  const defaultTitle = titles[0] || 'SVP technology banking';
  const defaultLoc = locations[0] || 'Singapore';
  const titleQueries = titles.length ? titles.slice(0, 3) : [defaultTitle];
  const locs = locations.length ? locations.slice(0, 2) : [defaultLoc];
  const portals = portalsFromProfileSources(intake.sources || ['linkedin.com', 'jobstreet.com.sg']);
  const patterns = getPortalSearchPatterns(intake);
  const urls = [];

  for (const title of titleQueries) {
    for (const loc of locs) {
      for (const p of portals) {
        const template = patternForPortalKey(p.key, patterns) || p.search_url_template;
        if (!template) continue;
        urls.push({
          source: p.key.includes('linkedin')
            ? 'linkedin'
            : p.key.includes('jobstreet')
              ? 'jobstreet'
              : normalizePortalKey(p.key),
          label: p.label,
          portal_key: p.key,
          url: applySearchUrlPattern(template, { title, location: loc }),
        });
      }
    }
  }

  const seen = new Set();
  return urls
    .filter((u) => {
      if (seen.has(u.url)) return false;
      seen.add(u.url);
      return true;
    })
    .slice(0, 8);
}

export function pickPrimarySearchUrls(intake = {}) {
  const all = buildDiscoverySearchUrls(intake);
  const bySource = new Map();
  for (const entry of all) {
    const key = entry.source.includes('linkedin')
      ? 'linkedin'
      : entry.source.includes('jobstreet')
        ? 'jobstreet'
        : entry.source;
    if (!bySource.has(key)) bySource.set(key, entry);
  }
  return [...bySource.values()];
}

export function formatDiscoverySearchUrlsForPrompt(intake = {}) {
  const urls = buildDiscoverySearchUrls(intake);
  if (!urls.length) return '';
  return urls.map((u, i) => `${i + 1}. [${u.source}] ${u.url}`).join('\n');
}
