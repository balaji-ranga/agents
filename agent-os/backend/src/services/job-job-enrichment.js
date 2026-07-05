/**
 * Enrich job rows from portal URLs (LinkedIn / JobStreet slugs) when discovery omits title/company.
 */

function titleCaseSlug(slug) {
  return String(slug || '')
    .replace(/-/g, ' ')
    .replace(/\bat\b/gi, ' at ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse LinkedIn job view URL slug: .../jobs/view/vp-svp-technology-risk-at-kerry-consulting-4422775082 */
export function parseLinkedInJobUrl(url) {
  if (!url || !/linkedin\.com/i.test(url)) return null;
  const m = String(url).match(/\/jobs\/view\/([^/?#]+)/i);
  if (!m) return null;
  const slug = m[1].replace(/-\d{8,}$/, '');
  const atIdx = slug.lastIndexOf('-at-');
  if (atIdx > 0) {
    return {
      title: titleCaseSlug(slug.slice(0, atIdx)),
      company: titleCaseSlug(slug.slice(atIdx + 4)),
      source: 'linkedin.com',
    };
  }
  return { title: titleCaseSlug(slug), company: '', source: 'linkedin.com' };
}

/** Parse JobStreet slug patterns when present in URL path. */
export function parseJobStreetJobUrl(url) {
  if (!url || !/jobstreet\.com/i.test(url)) return null;
  const m = String(url).match(/\/job\/([^/?#]+)/i);
  if (!m) return null;
  const slug = m[1].replace(/-\d{5,}$/, '');
  const parts = slug.split('-');
  if (parts.length >= 2) {
    const company = titleCaseSlug(parts[parts.length - 1]);
    const title = titleCaseSlug(parts.slice(0, -1).join('-'));
    return { title, company, source: 'jobstreet.com' };
  }
  return { title: titleCaseSlug(slug), company: '', source: 'jobstreet.com.sg' };
}

export function inferSourceFromUrl(url) {
  if (!url) return '';
  if (/linkedin\.com/i.test(url)) return 'linkedin.com';
  if (/jobstreet\.com/i.test(url)) return 'jobstreet.com.sg';
  return '';
}

/** Merge parsed URL metadata into a job object (does not overwrite non-empty fields). */
export function enrichJobFromUrl(job = {}) {
  const url = (job.url || '').trim();
  if (!url) return { ...job };

  let parsed = parseLinkedInJobUrl(url) || parseJobStreetJobUrl(url);
  const out = { ...job };
  if (parsed) {
    if (!out.title?.trim()) out.title = parsed.title;
    if (!out.company?.trim()) out.company = parsed.company;
    if (!out.source?.trim()) out.source = parsed.source;
  }
  if (!out.source?.trim()) out.source = inferSourceFromUrl(url) || out.source;
  return out;
}
