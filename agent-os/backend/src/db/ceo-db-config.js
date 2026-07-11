/**
 * Per-CEO database layout: shared platform DB vs dedicated tenant ceo.db.
 */
import { getDb } from './schema.js';
import { isPlatformLegacyCeo } from '../services/job-applicant-ceo.js';

export const CEO_DB_MODES = ['shared', 'tenant'];

export function normalizeCeoDbMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'shared' || m === 'platform' || m === 'default') return 'shared';
  if (m === 'tenant' || m === 'tenanted' || m === 'dedicated' || m === 'private') return 'tenant';
  return null;
}

export function defaultCeoDbMode() {
  return normalizeCeoDbMode(process.env.AGENT_OS_CEO_DB_MODE_DEFAULT) || 'tenant';
}

export function getCeoDbModeForUser(ceoUserId) {
  const id = String(ceoUserId || '').trim();
  if (!id) return defaultCeoDbMode();
  if (isPlatformLegacyCeo(id)) return 'shared';

  const row = getDb().prepare('SELECT ceo_db_mode, role FROM platform_users WHERE id = ?').get(id);
  if (!row || row.role !== 'ceo') return 'shared';
  return normalizeCeoDbMode(row.ceo_db_mode) || defaultCeoDbMode();
}

export function usesTenantCeoDb(ceoUserId) {
  return getCeoDbModeForUser(ceoUserId) === 'tenant';
}

export function resolveRegisterCeoDbMode(dbMode) {
  const normalized = normalizeCeoDbMode(dbMode);
  if (!normalized) {
    throw new Error(`db_mode must be one of: ${CEO_DB_MODES.join(', ')}`);
  }
  return normalized;
}
