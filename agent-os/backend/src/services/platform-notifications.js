import { getDb } from '../db/schema.js';

function db() {
  return getDb();
}

export function sendPlatformNotifications({
  userIds = [],
  allUsers = false,
  title,
  body = '',
  linkUrl = '',
  createdBy,
}) {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) throw new Error('title is required');
  if (!createdBy) throw new Error('createdBy is required');

  let targets = [];
  if (allUsers) {
    targets = db()
      .prepare(`SELECT id FROM platform_users WHERE enabled = 1 ORDER BY name ASC`)
      .all()
      .map((r) => r.id);
  } else {
    const unique = [...new Set((userIds || []).map((id) => String(id).trim()).filter(Boolean))];
    if (!unique.length) throw new Error('Select at least one user or choose all users');
    const placeholders = unique.map(() => '?').join(',');
    targets = db()
      .prepare(
        `SELECT id FROM platform_users WHERE enabled = 1 AND id IN (${placeholders}) ORDER BY name ASC`
      )
      .all(...unique)
      .map((r) => r.id);
    if (!targets.length) throw new Error('No enabled users matched the selection');
  }

  const insert = db().prepare(
    `INSERT INTO platform_user_notifications (user_id, title, body, link_url, created_by)
     VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db().transaction((ids) => {
    for (const userId of ids) {
      insert.run(userId, trimmedTitle, String(body || '').trim(), String(linkUrl || '').trim() || null, createdBy);
    }
  });
  tx(targets);

  return { sent: targets.length, user_ids: targets };
}

export function listNotificationsForUser(userId, { limit = 30 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 30, 1), 100);
  return db()
    .prepare(
      `SELECT n.id, n.user_id, n.title, n.body, n.link_url, n.created_by, n.created_at,
              u.name AS created_by_name
       FROM platform_user_notifications n
       LEFT JOIN platform_users u ON u.id = n.created_by
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ?`
    )
    .all(userId, cap)
    .map((row) => ({
      id: row.id,
      kind: 'platform',
      title: row.title,
      body: row.body || '',
      link_url: row.link_url || null,
      created_at: row.created_at,
      created_by: row.created_by,
      created_by_name: row.created_by_name || 'Admin',
    }));
}
