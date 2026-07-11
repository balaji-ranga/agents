/**
 * Platform users, sessions, and per-user agent grants.
 */
import { randomBytes } from 'crypto';
import { getDb } from '../db/schema.js';
import { hashPassword, verifyPassword } from './auth/password.js';
import { initCeoDb } from '../db/ceo-db.js';
import { getBalaCeoAuthId, isPlatformLegacyCeo } from './job-applicant-ceo.js';
import {
  defaultCeoDbMode,
  getCeoDbModeForUser,
  resolveRegisterCeoDbMode,
} from '../db/ceo-db-config.js';

function slugId(prefix, email) {
  const base = String(email || '')
    .split('@')[0]
    .replace(/[^a-z0-9]+/gi, '-')
    .slice(0, 24)
    .toLowerCase();
  return `${prefix}-${base || 'user'}-${randomBytes(3).toString('hex')}`;
}

export function listStandardAgentIds() {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id FROM agents WHERE agent_type = 'standard' OR agent_type IS NULL OR agent_type = ''`)
    .all();
  return rows.map((r) => r.id);
}

export function grantStandardAgents(userId) {
  const db = getDb();
  const ids = listStandardAgentIds();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO user_agents (user_id, agent_id, enabled) VALUES (?, ?, 1)`
  );
  for (const agentId of ids) {
    insert.run(userId, agentId);
  }
  return ids;
}

export function registerCeoUser({ email, password, name, region = '', mobile = '', db_mode, ceo_db_mode }) {
  const db = getDb();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password || !name) {
    throw new Error('email, password, and name are required');
  }
  const existing = db.prepare('SELECT id FROM platform_users WHERE email = ?').get(normalizedEmail);
  if (existing) throw new Error('Email already registered');

  const id = slugId('ceo', normalizedEmail);
  const mode = resolveRegisterCeoDbMode(ceo_db_mode ?? db_mode ?? defaultCeoDbMode());

  db.prepare(
    `INSERT INTO platform_users (id, email, password_hash, name, region, mobile, role, enabled, ceo_db_mode)
     VALUES (?, ?, ?, ?, ?, ?, 'ceo', 1, ?)`
  ).run(
    id,
    normalizedEmail,
    hashPassword(password),
    String(name).trim(),
    String(region).trim(),
    String(mobile).trim(),
    mode
  );

  if (mode === 'tenant' && !isPlatformLegacyCeo(id)) initCeoDb(id);
  const agents = grantStandardAgents(id);

  return {
    id,
    email: normalizedEmail,
    name: String(name).trim(),
    region: String(region).trim(),
    mobile: String(mobile).trim(),
    role: 'ceo',
    enabled: true,
    ceo_db_mode: mode,
    standard_agents_granted: agents,
  };
}

export function registerAdminUser({ email, password, name, region = '', mobile = '' }) {
  const db = getDb();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password || !name) {
    throw new Error('email, password, and name are required');
  }
  const existing = db.prepare('SELECT id FROM platform_users WHERE email = ?').get(normalizedEmail);
  if (existing) throw new Error('Email already registered');

  const id = slugId('admin', normalizedEmail);
  db.prepare(
    `INSERT INTO platform_users (id, email, password_hash, name, region, mobile, role, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', 1)`
  ).run(id, normalizedEmail, hashPassword(password), String(name).trim(), String(region).trim(), String(mobile).trim());

  return {
    id,
    email: normalizedEmail,
    name: String(name).trim(),
    role: 'admin',
    enabled: true,
  };
}

export function authenticateUser(email, password) {
  const db = getDb();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const row = db.prepare('SELECT * FROM platform_users WHERE email = ?').get(normalizedEmail);
  if (!row || !row.enabled) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return userPublic(row);
}

export function userPublic(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    email: row.email,
    name: row.name,
    region: row.region || '',
    mobile: row.mobile || '',
    role: row.role,
    enabled: !!row.enabled,
    created_at: row.created_at,
  };
  if (row.role === 'ceo') {
    out.ceo_db_mode = getCeoDbModeForUser(row.id);
  }
  return out;
}

export function getUserById(id) {
  const row = getDb().prepare('SELECT * FROM platform_users WHERE id = ?').get(id);
  return userPublic(row);
}

export function listUsers() {
  return getDb()
    .prepare(
      `SELECT id, email, name, region, mobile, role, enabled, ceo_db_mode, created_at, updated_at
       FROM platform_users ORDER BY created_at DESC`
    )
    .all()
    .map((row) => ({
      ...row,
      enabled: !!row.enabled,
      ceo_db_mode: row.role === 'ceo' ? row.ceo_db_mode || defaultCeoDbMode() : null,
    }));
}

export function setUserEnabled(userId, enabled) {
  getDb()
    .prepare(`UPDATE platform_users SET enabled = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(enabled ? 1 : 0, userId);
  return getUserById(userId);
}

export function listUserAgents(userId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT ua.user_id, ua.agent_id, ua.enabled, ua.granted_at,
              a.name, a.role, a.agent_type, a.owner_user_id
       FROM user_agents ua
       JOIN agents a ON a.id = ua.agent_id
       WHERE ua.user_id = ?
       ORDER BY a.agent_type, a.name`
    )
    .all(userId);
}

export function listAgentsForUser(userId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT a.*, ua.enabled AS user_enabled
       FROM user_agents ua
       JOIN agents a ON a.id = ua.agent_id
       WHERE ua.user_id = ? AND ua.enabled = 1
       ORDER BY a.name`
    )
    .all(userId);
}

export function setUserAgentEnabled(userId, agentId, enabled) {
  const db = getDb();
  const agent = db.prepare('SELECT id, agent_type FROM agents WHERE id = ?').get(agentId);
  if (!agent) throw new Error('Agent not found');
  db.prepare(
    `INSERT INTO user_agents (user_id, agent_id, enabled) VALUES (?, ?, ?)
     ON CONFLICT(user_id, agent_id) DO UPDATE SET enabled = excluded.enabled`
  ).run(userId, agentId, enabled ? 1 : 0);
  return { user_id: userId, agent_id: agentId, enabled: !!enabled };
}

export function grantUserAgent(userId, agentId) {
  return setUserAgentEnabled(userId, agentId, true);
}

export function revokeUserAgent(userId, agentId) {
  return setUserAgentEnabled(userId, agentId, false);
}

export function updateUserProfile(userId, { name, email, region, mobile, current_password, new_password } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(userId);
  if (!row) throw new Error('User not found');

  const updates = {};
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw new Error('name cannot be empty');
    updates.name = trimmed;
  }
  if (region !== undefined) updates.region = String(region).trim();
  if (mobile !== undefined) updates.mobile = String(mobile).trim();

  if (email !== undefined) {
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!normalizedEmail) throw new Error('email cannot be empty');
    const existing = db.prepare('SELECT id FROM platform_users WHERE email = ? AND id != ?').get(normalizedEmail, userId);
    if (existing) throw new Error('Email already in use');
    updates.email = normalizedEmail;
  }

  if (new_password !== undefined && String(new_password).length > 0) {
    if (!current_password) throw new Error('current_password required to change password');
    if (!verifyPassword(current_password, row.password_hash)) throw new Error('Current password is incorrect');
    if (String(new_password).length < 8) throw new Error('new_password must be at least 8 characters');
    updates.password_hash = hashPassword(new_password);
  }

  const fields = Object.keys(updates);
  if (fields.length === 0) throw new Error('No fields to update');

  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE platform_users SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(
    ...fields.map((f) => updates[f]),
    userId
  );
  return getUserById(userId);
}

export function listAllAgentsGrouped() {
  const db = getDb();
  const standard = db
    .prepare(`SELECT * FROM agents WHERE agent_type = 'standard' OR agent_type IS NULL ORDER BY name`)
    .all();
  const custom = db
    .prepare(`SELECT * FROM agents WHERE agent_type = 'custom' ORDER BY name`)
    .all();
  return { standard, custom };
}

export function ensureDefaultAdmin() {
  const email = (process.env.AGENT_OS_ADMIN_EMAIL || 'admin@agent-os.local').trim().toLowerCase();
  const password = process.env.AGENT_OS_ADMIN_PASSWORD || 'admin-change-me';
  const db = getDb();
  const existing = db.prepare('SELECT id FROM platform_users WHERE role = ? LIMIT 1').get('admin');
  if (existing) return null;
  const user = registerAdminUser({ email, password, name: 'Platform Admin', region: 'global' });
  console.log(`Agent OS: seeded admin user ${user.email} (change AGENT_OS_ADMIN_PASSWORD)`);
  return user;
}

/**
 * Bala CEO — fixed auth id `ceo-bala`, uses existing platform DB (ceo_user_id `default`).
 * Does not create a tenant ceo.db.
 */
export function ensureBalaCeoUser() {
  const db = getDb();
  const id = getBalaCeoAuthId();
  const email = (process.env.AGENT_OS_BALA_EMAIL || 'bala@agent-os.local').trim().toLowerCase();
  const password = process.env.AGENT_OS_BALA_PASSWORD || 'bala-change-me';
  const name = process.env.AGENT_OS_BALA_NAME || 'Balaji Muthukrishnan';
  const region = process.env.AGENT_OS_BALA_REGION || 'Singapore';
  const mobile = process.env.AGENT_OS_BALA_MOBILE || '';

  let row = db.prepare('SELECT id FROM platform_users WHERE id = ?').get(id);
  if (!row) {
    const byEmail = db.prepare('SELECT id FROM platform_users WHERE email = ?').get(email);
    if (byEmail) {
      console.log(`Agent OS: Bala CEO email ${email} already used by ${byEmail.id}`);
      row = byEmail;
    }
  }

  if (!row) {
    db.prepare(
      `INSERT INTO platform_users (id, email, password_hash, name, region, mobile, role, enabled, ceo_db_mode)
       VALUES (?, ?, ?, ?, ?, ?, 'ceo', 1, 'shared')`
    ).run(id, email, hashPassword(password), name, region, mobile);
    console.log(`Agent OS: seeded Bala CEO ${email} (id=${id}) — uses existing platform DB`);
    grantStandardAgents(id);
    return { id, email, name, created: true };
  }

  grantStandardAgents(row.id);
  return { id: row.id, email, name, created: false };
}
