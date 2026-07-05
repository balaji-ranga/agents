/**
 * Resolve CEO user id from request (logged-in human / dashboard chat user).
 */
export function getDefaultCeoUserId() {
  return (process.env.AGENT_OS_CEO_USER_ID || 'default').trim() || 'default';
}

/** Auth account id for Bala — owns the original platform SQLite data. */
export function getBalaCeoAuthId() {
  return (process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala').trim() || 'ceo-bala';
}

/** True when this id uses agent-os.db (legacy / Bala), not a tenant ceo.db. */
export function isPlatformLegacyCeo(ceoUserId) {
  const id = String(ceoUserId || '').trim();
  return id === getDefaultCeoUserId() || id === getBalaCeoAuthId();
}

/** Map auth id → ceo_user_id stored in job tables and spreadsheet paths. */
export function resolveCeoDataUserId(ceoUserId) {
  const id = String(ceoUserId || '').trim();
  if (isPlatformLegacyCeo(id)) return getDefaultCeoUserId();
  return id || getDefaultCeoUserId();
}

export function resolveCeoUserId(req, body = {}) {
  const fromBody = body?.ceo_user_id ?? body?.ceoUserId;
  const fromHeader =
    req?.headers?.['x-ceo-user-id'] ||
    req?.headers?.['x-user-id'] ||
    req?.headers?.['x-agent-os-user-id'];
  const raw = fromBody ?? fromHeader ?? getDefaultCeoUserId();
  return String(raw).trim() || getDefaultCeoUserId();
}

export function slugifyProfileId(name) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48);
  return base || 'profile';
}
