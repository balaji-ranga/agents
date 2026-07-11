import { getDb } from './schema.js';
import { getCeoDb } from './ceo-db.js';
import { isPlatformLegacyCeo } from '../services/job-applicant-ceo.js';
import { usesTenantCeoDb } from './ceo-db-config.js';

/** Shared platform DB or per-CEO tenant DB — decided at registration (ceo_db_mode). */
export function getDbForCeo(ceoUserId) {
  const id = String(ceoUserId || '').trim();
  if (isPlatformLegacyCeo(id)) return getDb();
  if (id.startsWith('ceo-') && usesTenantCeoDb(id)) return getCeoDb(id);
  return getDb();
}
