/**
 * Chat-triggerable agent workflows — list/trigger helpers for COO tools and CEO chat.
 */
import { getBalaCeoAuthId } from './job-applicant-ceo.js';
import * as store from './agent-workflow-store.js';
import { tryTriggerWorkflowFromChat, startAgentWorkflowRun } from './agent-workflow-runner.js';

export function resolveWorkflowOwnerUserId(req, body = {}, resolveAuthenticatedCeoUserId) {
  const explicit = body?.ceo_user_id ?? body?.ceoUserId ?? body?.owner_user_id;
  if (explicit) return String(explicit).trim();
  if (req?.authUser && resolveAuthenticatedCeoUserId) {
    return resolveAuthenticatedCeoUserId(req, body);
  }
  return getBalaCeoAuthId();
}

export function listChatTriggerableWorkflows(ownerUserId) {
  return store
    .listDefinitions(ownerUserId)
    .filter(
      (w) =>
        w.status === 'published' &&
        !w.paused &&
        Array.isArray(w.trigger_modes) &&
        w.trigger_modes.includes('chat') &&
        String(w.chat_trigger_phrase || '').trim()
    )
    .map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description || '',
      chat_trigger_phrase: w.chat_trigger_phrase,
      trigger_modes: w.trigger_modes,
      status: w.status,
      paused: !!w.paused,
    }));
}

/**
 * Start a workflow by chat phrase match or explicit workflow_id.
 */
export async function triggerAgentWorkflowForOwner(ownerUserId, { message = '', workflow_id, input, actor } = {}) {
  const msg = String(message || input || '').trim();
  if (workflow_id) {
    const def = store.getDefinition(String(workflow_id).trim(), ownerUserId);
    if (!def) throw new Error(`Workflow not found: ${workflow_id}`);
    if (!store.isWorkflowTriggerable(def)) throw new Error('Workflow is not runnable (draft, paused, or unpublished)');
    return startAgentWorkflowRun(def.id, ownerUserId, {
      trigger: 'chat',
      input: msg || `Triggered via COO for ${def.name}`,
      actor,
    });
  }
  if (!msg) throw new Error('message or workflow_id required');
  const run = await tryTriggerWorkflowFromChat(ownerUserId, msg, actor);
  if (!run) {
    const available = listChatTriggerableWorkflows(ownerUserId);
    const phrases = available.map((w) => `"${w.chat_trigger_phrase}" (${w.id})`).join(', ');
    throw new Error(
      phrases
        ? `No workflow matched this message. Published chat phrases: ${phrases}`
        : 'No published chat-trigger workflows found for this CEO'
    );
  }
  return run;
}
