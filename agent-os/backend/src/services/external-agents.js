/**
 * External A2A agent registry — CRUD, discovery, invoke.
 */
import { randomBytes } from 'crypto';
import { getDb } from '../db/schema.js';
import {
  fetchAgentCard,
  a2aSendMessage,
  a2aSendAndWait,
  resolveA2AEndpoint,
} from './a2a-client.js';

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function slugId(name) {
  const base = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `a2a-${base || 'agent'}-${randomBytes(3).toString('hex')}`;
}

function sanitizeRow(row) {
  if (!row) return null;
  const { auth_header: _auth, agent_card_json, headers_json, ...rest } = row;
  return {
    ...rest,
    agent_card: parseJson(agent_card_json, null),
    headers: parseJson(headers_json, {}),
    is_platform: !!row.is_platform,
    has_auth: !!(_auth && String(_auth).trim()),
  };
}

function canView(row, authUser) {
  if (!row || !authUser) return false;
  if (authUser.role === 'admin') return true;
  if (row.is_platform && row.owner_role === 'admin') return true;
  return row.owner_user_id === authUser.id && row.owner_role === 'ceo';
}

function canEdit(row, authUser) {
  if (!canView(row, authUser)) return false;
  if (authUser.role === 'admin') return true;
  return row.owner_user_id === authUser.id && row.owner_role === 'ceo' && !row.is_platform;
}

function applyPermissions(server, authUser, row) {
  server.can_edit = canEdit(row, authUser);
  server.can_delete = canEdit(row, authUser);
  server.is_mine = row.owner_user_id === authUser.id;
  server.is_shared = !!row.is_platform && row.owner_role === 'admin';
}

function buildAuthHeaders(row) {
  const headers = { ...(parseJson(row.headers_json, {})) };
  const auth = String(row.auth_header || '').trim();
  if (auth) {
    if (auth.toLowerCase().startsWith('bearer ')) headers.Authorization = auth;
    else headers.Authorization = `Bearer ${auth}`;
  }
  return headers;
}

function isPlatformAdmin(authUser) {
  return authUser?.role === 'admin' && !authUser?.impersonation;
}

export function listExternalAgents(authUser, { forWorkflow = false } = {}) {
  const db = getDb();
  let rows;
  if (isPlatformAdmin(authUser)) {
    rows = db
      .prepare(
        `SELECT * FROM external_agents WHERE is_platform = 1 AND owner_role = 'admin' ORDER BY name ASC`
      )
      .all();
  } else {
    rows = db
      .prepare(
        `SELECT * FROM external_agents
         WHERE (owner_user_id = ? AND owner_role = 'ceo')
            OR (is_platform = 1 AND owner_role = 'admin')
         ORDER BY is_platform DESC, name ASC`
      )
      .all(authUser.id);
  }
  if (forWorkflow) rows = rows.filter((r) => r.status === 'healthy');
  return rows.map((row) => {
    const s = sanitizeRow(row);
    applyPermissions(s, authUser, row);
    if (forWorkflow) {
      s.skills = s.agent_card?.skills || [];
    }
    return s;
  });
}

export function getExternalAgent(id, authUser) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM external_agents WHERE id = ?').get(id);
  if (!row || !canView(row, authUser)) return null;
  const s = sanitizeRow(row);
  applyPermissions(s, authUser, row);
  return s;
}

/** Load agent for workflow execution (no auth user — internal). */
export function getExternalAgentForRun(id, ownerUserId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM external_agents WHERE id = ?').get(id);
  if (!row) return null;
  if (row.owner_user_id !== ownerUserId && !row.is_platform) return null;
  return row;
}

export function createExternalAgent(authUser, body = {}) {
  const name = String(body.name || '').trim();
  const cardUrl = String(body.card_url || body.cardUrl || body.url || '').trim();
  const endpointUrl = String(body.endpoint_url || body.endpointUrl || '').trim();
  if (!name) throw new Error('name is required');
  if (!cardUrl && !endpointUrl) throw new Error('card_url or endpoint_url is required');

  const db = getDb();
  const id = body.id?.trim() || slugId(name);
  db.prepare(
    `INSERT INTO external_agents (
      id, name, description, card_url, endpoint_url, skill_id, auth_header, headers_json,
      owner_user_id, owner_role, is_platform, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'))`
  ).run(
    id,
    name,
    String(body.description || '').trim(),
    cardUrl || null,
    endpointUrl || null,
    String(body.skill_id || body.skillId || '').trim() || null,
    String(body.auth_header || body.authHeader || '').trim() || null,
    JSON.stringify(body.headers || {}),
    authUser.id,
    authUser.role,
    authUser.role === 'admin' ? 1 : 0
  );
  return getExternalAgent(id, authUser);
}

export function updateExternalAgent(id, authUser, body = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM external_agents WHERE id = ?').get(id);
  if (!row || !canEdit(row, authUser)) throw new Error('Not allowed to edit this external agent');

  const patch = {
    name: body.name != null ? String(body.name).trim() : row.name,
    description: body.description != null ? String(body.description).trim() : row.description,
    card_url: body.card_url != null ? String(body.card_url || body.cardUrl || '').trim() : row.card_url,
    endpoint_url:
      body.endpoint_url != null ? String(body.endpoint_url || body.endpointUrl || '').trim() : row.endpoint_url,
    skill_id: body.skill_id != null ? String(body.skill_id || body.skillId || '').trim() || null : row.skill_id,
    auth_header: body.auth_header != null ? String(body.auth_header || body.authHeader || '').trim() || null : row.auth_header,
    headers_json: body.headers != null ? JSON.stringify(body.headers) : row.headers_json,
    status: body.status != null ? body.status : row.status,
  };

  db.prepare(
    `UPDATE external_agents SET
      name = ?, description = ?, card_url = ?, endpoint_url = ?, skill_id = ?,
      auth_header = ?, headers_json = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    patch.name,
    patch.description,
    patch.card_url,
    patch.endpoint_url,
    patch.skill_id,
    patch.auth_header,
    patch.headers_json,
    patch.status,
    id
  );
  return getExternalAgent(id, authUser);
}

export function deleteExternalAgent(id, authUser) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM external_agents WHERE id = ?').get(id);
  if (!row || !canEdit(row, authUser)) throw new Error('Not allowed to delete this external agent');
  db.prepare('DELETE FROM external_agents WHERE id = ?').run(id);
  return { ok: true };
}

export async function discoverExternalAgent(id, authUser) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM external_agents WHERE id = ?').get(id);
  if (!row || !canView(row, authUser)) throw new Error('External agent not found');

  const headers = buildAuthHeaders(row);
  let card = parseJson(row.agent_card_json, null);
  let cardUrl = row.card_url;
  let endpoint = row.endpoint_url;

  const cardSource = row.card_url || (isLikelyAgentCardUrl(row.endpoint_url) ? row.endpoint_url : null);

  if (cardSource) {
    const fetched = await fetchAgentCard(cardSource, { headers });
    card = fetched.card;
    cardUrl = fetched.cardUrl;
    endpoint = resolveA2AEndpoint(card, isLikelyAgentCardUrl(row.endpoint_url) ? null : row.endpoint_url);
  } else if (row.endpoint_url) {
    endpoint = String(row.endpoint_url).trim();
    if (isLikelyAgentCardUrl(endpoint)) {
      throw new Error(
        'endpoint_url looks like an agent card JSON path — put it in Agent card URL instead, or use the service root (e.g. https://agent.example.com/)'
      );
    }
  } else {
    throw new Error('card_url or endpoint_url required for discovery');
  }

  if (!endpoint || isLikelyAgentCardUrl(endpoint)) {
    throw new Error('Could not resolve A2A endpoint URL from agent card — set endpoint_url to the JSON-RPC service root');
  }

  db.prepare(
    `UPDATE external_agents SET
      agent_card_json = ?, endpoint_url = ?, card_url = ?,
      status = 'healthy', last_health_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(JSON.stringify(card), endpoint, cardUrl || row.card_url, id);

  return getExternalAgent(id, authUser);
}

function isLikelyAgentCardUrl(url) {
  const u = String(url || '').trim();
  return u.includes('/.well-known/') || /\.json(\?|$)/i.test(u);
}

export async function invokeExternalAgent(id, ownerUserId, { message, skillId, contextId, timeoutMs, waitForCompletion } = {}) {
  const row = getExternalAgentForRun(id, ownerUserId);
  if (!row) throw new Error(`External agent not found: ${id}`);
  if (row.status !== 'healthy') throw new Error(`External agent "${row.name}" is not healthy — run Discover first`);

  const card = parseJson(row.agent_card_json, {});
  const endpoint = resolveA2AEndpoint(card, row.endpoint_url);
  const headers = buildAuthHeaders(row);
  const skill = skillId || row.skill_id || null;

  if (waitForCompletion === false) {
    const sendResult = await a2aSendMessage(endpoint, message, {
      headers,
      skillId: skill,
      contextId,
      timeoutMs: Number(timeoutMs || 90000),
    });
    return {
      ok: true,
      text: sendResult.text || '',
      task_id: sendResult.taskId,
      task_state: sendResult.taskState,
      endpoint,
      agent_id: id,
      agent_name: row.name,
      result: sendResult.response,
    };
  }

  const result = await a2aSendAndWait(endpoint, message, {
    headers,
    skillId: skill,
    contextId,
    timeoutMs: Number(timeoutMs || 120000),
    waitForCompletion: waitForCompletion !== false,
  });

  return {
    ok: !!result.ok,
    text: result.text || '',
    task_id: result.taskId,
    task_state: result.taskState,
    endpoint,
    agent_id: id,
    agent_name: row.name,
    result: result.result,
  };
}
