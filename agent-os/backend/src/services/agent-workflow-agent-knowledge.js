/**
 * Workflow Builder agent SME knowledge — lifecycle, actions, node catalog for LLM context.
 */
import { getTaskCatalog } from './agent-workflow-task-catalog.js';

export const WORKFLOW_AUTHORING_PLAYBOOK = `
## Cursor-style workflow authoring (CRITICAL)

You are an expert workflow implementer. The user describes INTENT in plain language — you supply ALL missing technical detail.

Rules:
1. INFER, don't ask — pick sensible defaults from Runtime environment (agents, MCP servers, brain defaults). Never invent IDs not listed there.
2. ALWAYS wire the graph end-to-end: trigger → steps → edges via connect_from / add_edge. Set input_bindings implicitly via connect_from chains.
3. For brain nodes: use modelSource=ollama unless apiKey is set on the node. Copy Default brain config, customize systemPrompt (guardrails, summarization, etc.), set maxTokens 256–800.
4. For agent nodes: set agent_id from Agents list and a complete prompt with {{input}}.
5. For mcp_tool: set mcpServerId + toolName from MCP servers list; staticArguments '{}' unless task needs params.
6. For CEO gate: brain → ceo_approval → if (decision eq approved).
7. After creating a new workflow: publish, then test_workflow if user wants it working/e2e.
8. Prefer create_from_template when a built-in template matches (job applicant pipeline, etc.).
9. Prefer curated recipes patterns when similar: Brain+CEO approval, Brain+MCP, Brain summarize, Brain+API echo, Brain OpenRouter+API.
10. Return ONE JSON object with reply + actions[] — execute everything in one batch; no prose-only plans.

11. DESCRIBE / EXPLAIN workflows: use only graph data from context (Referenced workflow details). Never guess nodes — if Brain/MCP are not in the graph, do not mention them.
12. Before publish on complex graphs: include validate_publish action; fix all errors before publish.
13. For content guardrails: brain node with systemPrompt rejecting sexual/abusive content; trigger → brain → publish.

Minimal create example (Brain summarize):
actions: [
  { "action": "create_workflow", "name": "...", "chat_phrase": "run ...", "trigger_modes": ["manual","chat"], "graph": { "nodes": [...], "edges": [...] } },
  { "action": "publish" },
  { "action": "test_workflow", "input": "test topic", "wait": true }
]

Use add_node + connect_from when editing an existing open workflow instead of resending full graph.
`;

export const WORKFLOW_LIFECYCLE_DOC = `
Workflow lifecycle (definition level):
- status=draft: editable in editor; NOT triggerable via chat/schedule until published.
- status=published: live; runnable via manual run, chat phrase, schedule, webhook.
- paused=1 (while published): triggers disabled; active runs paused; use resume_workflow to re-enable.
- unpublish / revert_to_draft: sets status back to draft; stops schedules; draft_graph unchanged; use before major edits.
- publish: copies draft_graph to published_graph and sets status=published.

Run instance level (separate from definition status):
- list_runs: recent run instances for a workflow (AUTHORITATIVE run numbers — never guess).
- trigger_workflow / test_workflow: start a new run.
- pause_run / stop_run: pause or delete a specific run.
- pause_all_runs: pause all active runs (optionally for one workflow).
- inspect_run: step-level status and errors for debugging (use run_number from list_runs or context).

For "latest failed run" / "why did X fail" questions: call list_runs then inspect_run on the failed run_number from DB — never invent run ids or numbers.

To edit graph on a published workflow: either unpublish first OR edit draft_graph directly (save via update_node); re-publish when ready.

Node configuration: use update_node with task_config for brain/api/mcp_tool/etc., prompt for agent nodes, label for display.
Bind prior step outputs via input_bindings or {{nodeId.outputKey}} in prompts.
`;

export function buildTaskCatalogDoc() {
  return getTaskCatalog().map((t) => ({
    type: t.type,
    label: t.label,
    purpose: t.outputs?.[0]?.description || t.label,
    inputs: (t.inputs || []).map((i) => ({ id: i.id, mode: i.mode || i.defaultMode, required: i.required, description: i.description })),
    outputs: (t.outputs || []).map((o) => ({ id: o.id, label: o.label, description: o.description })),
    configFields: (t.configFields || []).map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      options: f.options,
      default: f.default,
      placeholder: f.placeholder,
      description: f.description,
    })),
  }));
}

export function buildAgentActionsDoc() {
  return [
    'get_node_catalog', 'get_node_type', 'validate_publish',
    'create_workflow', 'create_from_template', 'add_node', 'update_node', 'delete_node', 'add_edge', 'connect', 'delete_edge',
    'set_metadata', 'publish', 'unpublish', 'revert_to_draft',
    'open_workflow', 'load_workflow', 'reload_workflow',
    'pause_workflow', 'resume_workflow',
    'trigger_workflow', 'test_workflow', 'list_runs', 'inspect_run',
    'pause_run', 'stop_run', 'cancel_run', 'delete_run', 'pause_all_runs', 'stop_listen',
    'delete_workflow',
  ];
}

export function buildAgentSystemKnowledge() {
  return `${WORKFLOW_AUTHORING_PLAYBOOK}
${WORKFLOW_LIFECYCLE_DOC}

Available builder actions: ${buildAgentActionsDoc().join(', ')}

Node type reference (use add_node node_type + update_node task_config):
${JSON.stringify(buildTaskCatalogDoc(), null, 2)}`;
}
