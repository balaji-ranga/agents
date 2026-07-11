/**
 * Workflow task: invoke external agent via A2A protocol.
 */
import { renderWorkflowTemplates } from './agent-workflow-io.js';
import { invokeExternalAgent } from './external-agents.js';

export async function executeExternalAgentTask(resolvedInputs, nodeConfig = {}, context = null, ownerUserId = null) {
  const render = (v) => (context && v != null ? renderWorkflowTemplates(String(v), context) : String(v ?? ''));

  const externalAgentId = render(nodeConfig.externalAgentId || nodeConfig.external_agent_id).trim();
  if (!externalAgentId) throw new Error('External agent ID is required');

  const message =
    render(resolvedInputs.message || resolvedInputs.prompt || resolvedInputs.text).trim() ||
    render(resolvedInputs.input).trim();
  if (!message) throw new Error('Message / prompt input is required for external agent');

  const owner = ownerUserId || context?.owner_user_id || context?.ownerUserId;
  if (!owner) throw new Error('Workflow owner user id missing for external agent invoke');

  const skillId = render(nodeConfig.skillId || nodeConfig.skill_id).trim() || null;
  const contextId = render(resolvedInputs.contextId || resolvedInputs.context_id).trim() || null;
  const waitForCompletion = nodeConfig.waitForCompletion !== false && nodeConfig.wait_for_completion !== false;
  const timeoutMs = Number(nodeConfig.timeoutMs || nodeConfig.timeout_ms || 120000);

  const out = await invokeExternalAgent(externalAgentId, owner, {
    message,
    skillId,
    contextId,
    timeoutMs,
    waitForCompletion,
  });

  return {
    ok: out.ok,
    text: out.text,
    result: out.result,
    task_id: out.task_id,
    task_state: out.task_state,
    agent_id: out.agent_id,
    agent_name: out.agent_name,
  };
}
