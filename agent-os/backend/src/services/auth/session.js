import { randomBytes } from 'crypto';
import { getDb } from '../../db/schema.js';

const SESSION_DAYS = Number(process.env.AGENT_OS_SESSION_DAYS || 14);

export function createSession(userId, { impersonatorUserId = null } = {}) {
  const db = getDb();
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(
    `INSERT INTO platform_sessions (token, user_id, expires_at, impersonator_user_id) VALUES (?, ?, ?, ?)`
  ).run(token, userId, expires, impersonatorUserId || null);
  return { token, expires_at: expires };
}

export function getSessionRow(token) {
  if (!token) return null;
  const db = getDb();
  return db
    .prepare(
      `SELECT s.token, s.expires_at, s.impersonator_user_id,
              u.id, u.email, u.name, u.region, u.mobile, u.role, u.enabled,
              imp.name AS impersonator_name, imp.email AS impersonator_email
       FROM platform_sessions s
       JOIN platform_users u ON u.id = s.user_id
       LEFT JOIN platform_users imp ON imp.id = s.impersonator_user_id
       WHERE s.token = ?`
    )
    .get(token);
}

export function getSessionUser(token) {
  const row = getSessionRow(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    getDb().prepare('DELETE FROM platform_sessions WHERE token = ?').run(token);
    return null;
  }
  if (!row.enabled) return null;
  const user = {
    id: row.id,
    email: row.email,
    name: row.name,
    region: row.region,
    mobile: row.mobile,
    role: row.role,
    enabled: !!row.enabled,
  };
  if (row.impersonator_user_id) {
    user.impersonation = {
      admin_id: row.impersonator_user_id,
      admin_name: row.impersonator_name || row.impersonator_user_id,
      admin_email: row.impersonator_email || '',
    };
  }
  return user;
}

export function revokeSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM platform_sessions WHERE token = ?').run(token);
}

export function revokeAllSessions(userId) {
  getDb().prepare('DELETE FROM platform_sessions WHERE user_id = ?').run(userId);
}
