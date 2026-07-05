import { getDb } from './schema.js';
import { getCeoDb } from './ceo-db.js';
import { isPlatformLegacyCeo } from '../services/job-applicant-ceo.js';

/** Platform DB for Bala / legacy default; per-CEO tenant DB for new registrations. */
export function getDbForCeo(ceoUserId) {
  const id = String(ceoUserId || '').trim();
  if (isPlatformLegacyCeo(id)) return getDb();
  if (id.startsWith('ceo-')) return getCeoDb(id);
  return getDb();
}
