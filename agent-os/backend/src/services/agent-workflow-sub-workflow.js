/**
 * Invoke another published workflow from a sub-workflow node.
 */
import * as store from './agent-workflow-store.js';
import { renderWorkflowTemplates } from './agent-workflow-io.js';
import { triggerWorkflowFromHook } from './agent-workflow-webhooks.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForChildRun(runId, ownerUserId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = store.getRun(runId, ownerUserId);
    if (run?.status === 'completed' || run?.status === 'failed') return run;
    await sleep(400);
  }
  return store.getRun(runId, ownerUserId);
}

export async function executeSubWorkflowTask(config = {}, context = {}, ownerUserId, actor = null) {
  const targetWorkflowId = String(config.targetWorkflowId || config.target_workflow_id || '').trim();
  if (!targetWorkflowId) throw new Error('Target workflow ID is required');

  const triggerMode = String(config.triggerMode || config.trigger_mode || 'manual').toLowerCase();
  const inputTemplate = config.inputTemplate ?? config.input_template ?? '{}';
  const input = renderWorkflowTemplates(String(inputTemplate), context);
  const waitForCompletion = config.waitForCompletion === true || config.wait_for_completion === true;

  const def = store.getDefinition(targetWorkflowId, ownerUserId);
  if (!def) throw new Error(`Target workflow not found: ${targetWorkflowId}`);
  if (def.status !== 'published') throw new Error(`Target workflow must be published: ${targetWorkflowId}`);
  if (!def.trigger_modes?.includes(triggerMode)) {
    throw new Error(`Target workflow does not allow trigger mode "${triggerMode}"`);
  }

  const act = actor || { id: 'sub-workflow', name: 'Sub-workflow', type: 'system' };
  let child;

  if (triggerMode === 'event') {
    let payload;
    try {
      payload = JSON.parse(input);
    } catch {
      payload = { input };
    }
    child = await triggerWorkflowFromHook(targetWorkflowId, payload, { actor: act });
  } else if (triggerMode === 'chat') {
    const { startAgentWorkflowRun } = await import('./agent-workflow-runner.js');
    child = await startAgentWorkflowRun(targetWorkflowId, ownerUserId, {
      trigger: 'chat',
      input: input || def.chat_trigger_phrase || '',
      actor: act,
    });
  } else {
    const { startAgentWorkflowRun } = await import('./agent-workflow-runner.js');
    child = await startAgentWorkflowRun(targetWorkflowId, ownerUserId, {
      trigger: 'manual',
      input,
      actor: act,
    });
  }

  let final = child;
  if (waitForCompletion && child?.id) {
    final = (await waitForChildRun(child.id, ownerUserId)) || child;
  }

  return {
    ok: final?.status === 'completed',
    run_id: final?.id,
    run_number: final?.run_number,
    definition_id: targetWorkflowId,
    definition_name: def.name,
    status: final?.status,
    trigger: triggerMode,
    text: `Invoked ${def.name} (#${final?.run_number}) via ${triggerMode}`,
  };
}
