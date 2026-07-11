import { timingSafeEqual } from 'crypto';
import { getPublicBaseUrl } from '../config/public-url.js';
import { getDb } from '../db/schema.js';
import * as store from './agent-workflow-store.js';
import { startAgentWorkflowRun } from './agent-workflow-runner.js';

function db() {
  return getDb();
}

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyHookSecret(definitionId, providedSecret) {
  const row = db().prepare('SELECT webhook_secret, trigger_modes, owner_user_id FROM agent_workflow_definitions WHERE id = ?').get(definitionId);
  if (!row) return { ok: false, error: 'Workflow not found' };
  const modes = String(row.trigger_modes || '')
    .split(',')
    .map((s) => s.trim());
  if (!modes.includes('event')) return { ok: false, error: 'Event trigger is disabled for this workflow' };
  if (!row.webhook_secret) return { ok: false, error: 'Webhook secret not configured — re-save triggers with event mode enabled' };
  if (!secretsMatch(providedSecret, row.webhook_secret)) {
    return { ok: false, error: 'Invalid hook secret' };
  }
  return { ok: true, ownerUserId: row.owner_user_id };
}

export async function triggerWorkflowFromHook(definitionId, payload = {}, { actor = null } = {}) {
  const row = db().prepare('SELECT owner_user_id, status, paused FROM agent_workflow_definitions WHERE id = ?').get(definitionId);
  if (!row) throw new Error('Workflow not found');
  if (row.paused) throw new Error('Workflow is paused');
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}, null, 0);
  return startAgentWorkflowRun(definitionId, row.owner_user_id, {
    trigger: 'event',
    input,
    actor: actor || { id: 'event-hook', name: 'Event hook', type: 'system' },
  });
}

export function hookUrlForDefinition(definitionId, baseUrl) {
  const base = String(baseUrl || getPublicBaseUrl()).replace(/\/$/, '');
  return `${base}/api/agent-workflows/hooks/${definitionId}`;
}

export function getHookInfo(definitionId, ownerUserId) {
  const def = store.getDefinition(definitionId, ownerUserId);
  if (!def) return null;
  const secret = def.trigger_modes?.includes('event') ? store.ensureWebhookSecret(definitionId) : def.webhook_secret || null;
  return {
    hook_url: hookUrlForDefinition(definitionId),
    webhook_secret: secret,
    trigger_modes: def.trigger_modes,
  };
}
