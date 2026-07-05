/**
 * Workflow Builder agent — LLM chat with structured graph mutations.
 * Uses config/llm.js → same OPENAI_API_KEY + OPENAI_BASE_URL as OpenClaw gateway (.env).
 */
import { chatCompletions } from '../config/llm.js';
import { getTaskCatalog } from './agent-workflow-task-catalog.js';
import {
  applyWorkflowBuilderActions,
  getWorkflowDraftForAgent,
  summarizeGraphForAgent,
} from './agent-workflow-builder.js';
import * as store from './agent-workflow-store.js';
import { listChatTriggerableWorkflows } from './agent-workflow-chat-tools.js';

const WORKFLOW_BUILDER_AGENT_ID = 'workflowbuilder';

const SYSTEM_PROMPT = `You are the Workflow Builder agent for Agent OS. You help CEOs design, edit, and run custom agent workflows (visual step graphs).

Respond with a single JSON object (no markdown fences) in this shape:
{
  "reply": "Human-readable explanation of what you did or need",
  "actions": [ ... ]
}

actions is an array of mutation objects. Available actions:

1. create_workflow — { "action": "create_workflow", "name": "...", "description": "...", "chat_phrase": "run my workflow", "trigger_modes": ["manual","chat"] }
2. add_node — { "action": "add_node", "node_type": "agent|brain|email|ceo_approval|if|while|tool|api|trigger", "label": "...", "node_id": "optional", "position": {"x":240,"y":120}, "agent_id": "techresearcher", "prompt": "...", "connect_from": "prior-node-id", "source_handle": "true|false|loop|exit" }
3. update_node — { "action": "update_node", "node_id": "...", "label": "...", "prompt": "...", "task_config": { ... } }
4. delete_node — { "action": "delete_node", "node_id": "..." }
5. add_edge / connect — { "action": "add_edge", "source": "node-a", "target": "node-b", "source_handle": "true" }
6. set_metadata — { "action": "set_metadata", "name": "...", "chat_phrase": "...", "trigger_modes": ["manual","chat"] }
7. publish — { "action": "publish" }
8. trigger_workflow — { "action": "trigger_workflow", "message": "run phrase or input" }

Node types: trigger, agent, brain, ceo_approval, if, while, email, api, tool, parallel, merge.
Every workflow needs a trigger node (id usually trigger-1). Connect steps with add_edge or connect_from on add_node.
For IF nodes use source_handle "true" or "false" on edges. For While: "loop" or "exit".

If the user only asks a question, return empty actions [].
If editing an existing workflow, use the provided graph context — do not recreate unless asked.
Keep node ids stable when updating. Prefer connect_from when adding sequential steps.`;

function parseAgentJson(content) {
  const text = String(content || '').trim();
  if (!text) return { reply: '', actions: [] };
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return { reply: text, actions: [] };
      }
    }
    return { reply: text, actions: [] };
  }
}

function buildUserContext({ workflowId, ownerUserId, message }) {
  const parts = [`CEO request:\n${message}`];
  if (workflowId) {
    try {
      const draft = getWorkflowDraftForAgent(ownerUserId, workflowId);
      parts.push(`\nCurrent workflow id: ${draft.workflow_id}`);
      parts.push(`Name: ${draft.name}`);
      parts.push(`Status: ${draft.status}`);
      parts.push(`Chat phrase: ${draft.chat_trigger_phrase || '(none)'}`);
      parts.push(`Graph summary: ${JSON.stringify(draft.graph_summary, null, 2)}`);
    } catch {
      parts.push(`\n(workflow ${workflowId} not found — you may create_workflow)`);
    }
  } else {
    parts.push('\nNo workflow selected — use create_workflow to start a new one, or ask which workflow to open.');
    const list = listChatTriggerableWorkflows(ownerUserId);
    if (list.length) {
      parts.push(`\nPublished chat-trigger workflows: ${list.map((w) => `${w.id} ("${w.chat_trigger_phrase}")`).join(', ')}`);
    }
  }
  const types = getTaskCatalog().map((t) => `${t.type}: ${t.label}`).join(', ');
  parts.push(`\nAvailable step types: ${types}`);
  return parts.join('\n');
}

/**
 * Run one workflow-builder chat turn (may execute multiple actions).
 */
export async function runWorkflowBuilderChat({
  ownerUserId,
  workflowId = null,
  message,
  history = [],
  actor = null,
}) {
  const trimmed = String(message || '').trim();
  if (!trimmed) throw new Error('message required');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-12).map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.content || ''),
    })),
    { role: 'user', content: buildUserContext({ workflowId, ownerUserId, message: trimmed }) },
  ];

  const { content, modelUsed } = await chatCompletions({ messages, maxTokens: 2048 });
  const parsed = parseAgentJson(content);
  const reply = parsed.reply || content;
  let actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  let result = null;
  let effectiveWorkflowId = workflowId;

  if (actions.length) {
    result = await applyWorkflowBuilderActions(ownerUserId, effectiveWorkflowId, actions, {
      ...actor,
      id: actor?.id || WORKFLOW_BUILDER_AGENT_ID,
      name: actor?.name || 'Workflow Builder',
    });
    effectiveWorkflowId = result.workflow_id;
  }

  let workflowTriggered = null;
  const triggerAction = actions.find((a) => ['trigger_workflow', 'trigger_run'].includes(a.action || a.op));
  if (triggerAction && result?.results) {
    const tr = result.results.find((r) => r.action === 'trigger_workflow' || r.action === 'trigger_run');
    if (tr?.run_id) {
      workflowTriggered = {
        run_id: tr.run_id,
        run_number: tr.run_number,
        definition_id: tr.definition_id,
      };
    }
  }

  const workflow = effectiveWorkflowId ? store.getDefinition(effectiveWorkflowId, ownerUserId) : null;

  return {
    reply,
    model_used: modelUsed,
    workflow_id: effectiveWorkflowId,
    draft_graph: workflow?.draft_graph || result?.draft_graph || null,
    graph_summary: workflow ? summarizeGraphForAgent(workflow.draft_graph) : result?.graph_summary,
    actions_applied: result?.results || [],
    workflow_triggered: workflowTriggered,
    workflow: workflow
      ? {
          id: workflow.id,
          name: workflow.name,
          status: workflow.status,
          chat_trigger_phrase: workflow.chat_trigger_phrase,
        }
      : null,
  };
}

export { WORKFLOW_BUILDER_AGENT_ID };
