/** Shared intake normalizers for job applicant profile. */
export function normalizeLinkedInUrl(v) {
  if (!v || typeof v !== 'string') return '';
  let s = v.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  return s;
}

export function validateLinkedInProfile(v) {
  const url = normalizeLinkedInUrl(v);
  if (!url) return { ok: false, error: 'linkedin_profile URL required' };
  if (!/linkedin\.com/i.test(url)) return { ok: false, error: 'linkedin_profile must be a LinkedIn URL' };
  return { ok: true, url };
}
