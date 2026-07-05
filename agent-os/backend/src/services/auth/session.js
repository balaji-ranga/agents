import { randomBytes } from 'crypto';
import { getDb } from '../../db/schema.js';

const SESSION_DAYS = Number(process.env.AGENT_OS_SESSION_DAYS || 14);

export function createSession(userId) {
  const db = getDb();
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(
    `INSERT INTO platform_sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  ).run(token, userId, expires);
  return { token, expires_at: expires };
}

export function getSessionUser(token) {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, u.id, u.email, u.name, u.region, u.mobile, u.role, u.enabled
       FROM platform_sessions s
       JOIN platform_users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM platform_sessions WHERE token = ?').run(token);
    return null;
  }
  if (!row.enabled) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    region: row.region,
    mobile: row.mobile,
    role: row.role,
    enabled: !!row.enabled,
  };
}

export function revokeSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM platform_sessions WHERE token = ?').run(token);
}

export function revokeAllSessions(userId) {
  getDb().prepare('DELETE FROM platform_sessions WHERE user_id = ?').run(userId);
}
