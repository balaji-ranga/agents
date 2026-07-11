/**

 * Workflow Builder agent — LLM chat with structured graph mutations (workflow chatops SME).

 */

import { chatCompletions } from '../config/llm.js';

import { getTaskCatalog } from './agent-workflow-task-catalog.js';

import {

  applyWorkflowBuilderActions,

  getWorkflowDraftForAgent,

  summarizeGraphForAgent,

} from './agent-workflow-builder.js';

import * as store from './agent-workflow-store.js';

import { parseWorkflowAgentCommand } from './agent-workflow-chat-tools.js';

import {

  appendWorkflowChatExchange,

  listWorkflowChatTurns,

  workflowChatThreadKey,

} from './agent-workflow-chat-store.js';

import { buildAgentSystemKnowledge } from './agent-workflow-agent-knowledge.js';
import {
  buildWorkflowAgentRuntimeContext,
  formatRuntimeContextForPrompt,
} from './agent-workflow-agent-runtime-context.js';
import {
  matchWorkflowRecipe,
  buildRecipeActionBatch,
  enrichCreateWorkflowActions,
} from './agent-workflow-recipes.js';
import {
  findWorkflowsReferencedInMessage,
  formatWorkflowDescriptionBlock,
  tryDescribeWorkflowResponse,
} from './agent-workflow-agent-describe.js';
import { tryCatalogQueryResponse, formatCatalogForPrompt } from './agent-workflow-builder-catalog.js';



const WORKFLOW_BUILDER_AGENT_ID = 'workflowbuilder';



const SYSTEM_PROMPT = `You are the Workflow Builder agent (workflow chatops SME) for Agent OS. You create, edit, test, and operate visual agent workflows — full parity with the workflow UI.

You work like Cursor: user gives intent, you produce a complete working workflow with all nodes wired, configs filled, published, and tested when asked. Use Runtime environment IDs and defaults — never ask the user for node attribute details you can infer.

Respond with a single JSON object (no markdown fences):
{ "reply": "...", "actions": [ ... ] }



## Graph editing

- create_workflow — { "action": "create_workflow", "name": "...", "chat_phrase": "...", "trigger_modes": ["manual","chat"] }

- add_node — { "action": "add_node", "node_type": "...", "label": "...", "connect_from": "node-id", "agent_id": "...", "prompt": "...", "system_prompt": "...", "task_config": { } }

- update_node — { "action": "update_node", "node_id": "...", "label": "...", "prompt": "...", "task_config": { } }

- delete_node, add_edge/connect, delete_edge, set_metadata

## Catalog tools (read-only — use before building unfamiliar nodes)

- get_node_catalog — { "action": "get_node_catalog" } — all node types, inputs, outputs, config fields

- get_node_type — { "action": "get_node_type", "node_type": "brain" } — detailed spec + examples

- validate_publish — { "action": "validate_publish" } — preflight publish errors before publishing



## Definition lifecycle (CRITICAL)

- publish — { "action": "publish" } — draft → published

- unpublish / revert_to_draft — { "action": "unpublish" } OR { "action": "revert_to_draft", "workflow_id": "..." } — published → draft (REQUIRED before treating workflow as draft again)

- pause_workflow — disables triggers + pauses active runs

- resume_workflow — re-enables triggers

- open_workflow / reload_workflow — load workflow into editor context



## Runs

- trigger_workflow, test_workflow (run + wait + diagnostics), inspect_run, pause_run, stop_run, pause_all_runs, stop_listen

- delete_workflow



When user says "make draft", "unpublish", "revert to draft", or "change status to draft" → use unpublish or revert_to_draft with workflow_id. Do NOT only open_workflow — unpublish works from the workflows list without opening the editor.



## Test & fix

inspect_run / test_workflow → read failed step errors → update_node / add_edge → unpublish if needed → edit → publish → test_workflow again.



Use task_config for brain (modelSource, systemPrompt, mcpToolCalling, mcpServerIds), mcp_tool (mcpServerId, toolName), api, email, if/while conditions, etc.

Brain nodes (CRITICAL):
- Default modelSource=ollama (local, no API key). Platform .env keys are NEVER used for workflow runs.
- Only set openai/anthropic/openrouter when task_config.apiKey is provided on the node.
- For guardrails/content safety: use systemPrompt with clear rules; connect_from trigger-1; wire input via {{input}}.
- On published workflows, graph edits auto-unpublish to draft — then publish when done.
- Call validate_publish before publish if unsure; fix reported errors first.



If only answering a question, return actions: [].

When describing or explaining a workflow: use ONLY the "Referenced workflow details" / Graph JSON in context. Never invent nodes (e.g. do not add Brain/MCP unless present in graph). List each node's type, purpose, config, and edges exactly as stored.

Keep node ids stable. Match workflows by name/id/chat phrase from context.



${buildAgentSystemKnowledge()}`;



function normalizeParsedAgentResponse(parsed, fallbackText = '') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reply: fallbackText, actions: [] };
  }
  let actions = [];
  if (Array.isArray(parsed.actions)) {
    actions = parsed.actions.filter((a) => a && a.action);
  } else if (parsed.action) {
    actions = [parsed];
  }
  const reply = String(parsed.reply || '').trim() || (actions.length ? '' : fallbackText);
  return { reply, actions };
}

function parseAgentJson(content) {
  const text = String(content || '').trim();
  if (!text) return { reply: '', actions: [] };

  try {
    return normalizeParsedAgentResponse(JSON.parse(text), text);
  } catch {
    const blocks = [...text.matchAll(/\{[\s\S]*?\}/g)];
    const actionObjects = [];
    let wrapper = null;

    for (const block of blocks) {
      try {
        const obj = JSON.parse(block[0]);
        if (obj?.reply !== undefined || Array.isArray(obj?.actions)) {
          wrapper = obj;
        } else if (obj?.action) {
          actionObjects.push(obj);
        }
      } catch {
        /* try next block */
      }
    }

    if (!wrapper) {
      const greedy = text.match(/\{[\s\S]*\}/);
      if (greedy) {
        try {
          const obj = JSON.parse(greedy[0]);
          if (obj?.reply !== undefined || obj?.action || Array.isArray(obj?.actions)) {
            return normalizeParsedAgentResponse(obj, text);
          }
        } catch {
          /* fall through */
        }
      }
    }

    if (wrapper) return normalizeParsedAgentResponse(wrapper, text);
    if (actionObjects.length) {
      const prose = text.replace(/\{[\s\S]*?\}/g, '').trim();
      return { reply: prose || 'Done.', actions: actionObjects };
    }

    return { reply: text, actions: [] };
  }
}



function formatWorkflowLine(w) {

  return `- ${w.name} | id: ${w.id} | status: ${w.status}${w.paused ? ' | PAUSED' : ''}${w.chat_trigger_phrase ? ` | chat: "${w.chat_trigger_phrase}"` : ''}`;

}



function buildUserContext({ workflowId, ownerUserId, message }) {

  const parts = [`CEO request:\n${message}`];

  try {
    const runtime = buildWorkflowAgentRuntimeContext(ownerUserId);
    parts.push(formatRuntimeContextForPrompt(runtime));
  } catch {
    parts.push('\n(Runtime environment unavailable)');
  }

  const all = store.listDefinitions(ownerUserId);

  if (all.length) {

    parts.push(`\nAll workflows:\n${all.map(formatWorkflowLine).join('\n')}`);

  }

  const referenced = findWorkflowsReferencedInMessage(ownerUserId, message);
  if (referenced.length) {
    parts.push(
      '\n## Referenced workflow details (AUTHORITATIVE — describe ONLY these nodes; do not invent Brain/MCP/agent nodes not listed)'
    );
    for (const def of referenced) {
      parts.push(formatWorkflowDescriptionBlock(def));
    }
  }



  const activeRuns = store

    .listAllRuns(ownerUserId, 20)

    .filter((r) => ['running', 'pending', 'paused'].includes(r.status));

  if (activeRuns.length) {

    parts.push(

      `\nActive runs:\n${activeRuns

        .map((r) => `- run #${r.run_number} (id ${r.id}) | ${r.definition_id} | ${r.status}`)

        .join('\n')}`

    );

  }



  if (workflowId) {

    try {

      const draft = getWorkflowDraftForAgent(ownerUserId, workflowId);

      parts.push(`\nCurrently open: ${draft.name} (id: ${draft.workflow_id})`);

      parts.push(`Status: ${draft.status}${draft.paused ? ' (PAUSED)' : ''}`);

      if (draft.status === 'published') {

        parts.push('Note: workflow is PUBLISHED — use unpublish/revert_to_draft to return to draft status.');

      }

      parts.push(`Chat phrase: ${draft.chat_trigger_phrase || '(none)'}`);

      parts.push(`Graph: ${JSON.stringify(draft.graph_summary)}`);

      const runs = store.listRuns(workflowId, ownerUserId, 5);

      if (runs.length) {

        parts.push(`Recent runs: ${runs.map((r) => `#${r.run_number} ${r.status}`).join(', ')}`);

      }

    } catch {

      parts.push(`\n(workflow ${workflowId} not found)`);

    }

  } else {

    parts.push('\nNo workflow open — use open_workflow or create_workflow.');

  }



  parts.push(`\nStep types: ${getTaskCatalog().map((t) => t.type).join(', ')}`);
  parts.push('\nNode catalog summary (use get_node_type action for full spec):');
  parts.push(formatCatalogForPrompt());

  return parts.join('\n');

}



async function executeRecipePath(ownerUserId, workflowId, message, actor) {
  const runtime = buildWorkflowAgentRuntimeContext(ownerUserId);
  const recipe = matchWorkflowRecipe(message);
  if (!recipe) return null;

  const { actions, spec } = buildRecipeActionBatch(recipe, message, runtime);
  const result = await applyWorkflowBuilderActions(ownerUserId, workflowId, actions, actor);
  const effectiveWorkflowId = result.workflow_id || workflowId;
  const workflow = effectiveWorkflowId ? store.getDefinition(effectiveWorkflowId, ownerUserId) : null;

  let workflowTriggered = null;
  const tr = result.results?.find((r) => r.action === 'test_workflow' && r.run_id);
  if (tr) {
    workflowTriggered = { run_id: tr.run_id, run_number: tr.run_number, definition_id: tr.definition_id };
  }

  const reply = `Created **${spec.name}** (${recipe.label}). ${spec.summary}${spec.autoTest ? ' — test run included.' : ' — say "test workflow" to verify.'}`;

  return buildChatResultPayload({
    reply,
    modelUsed: null,
    effectiveWorkflowId,
    workflow,
    result,
    workflowTriggered,
  });
}



function formatAssistantReply(baseReply, result) {

  let text = baseReply || '';

  const applied = result?.actions_applied || result?.results || [];

  if (applied.length) {

    const summary = applied

      .map((a) => {

        let line = a.action;

        if (a.node_id) line += `: ${a.node_id}`;

        if (a.workflow_id) line += ` → ${a.workflow_id}`;

        if (a.status) line += ` [${a.status}]`;

        if (a.run_number) line += ` run #${a.run_number}`;

        if (a.ok === false && a.error) line += ` FAILED: ${a.error}`;

        return line;

      })

      .join(', ');

    text += `\n\n_Applied: ${summary}_`;

  }

  const failed = applied.filter((a) => a.ok === false && a.error);
  if (failed.length) {
    text += `\n\n**Errors:**\n${failed.map((f) => `- **${f.action}**: ${f.error}`).join('\n')}`;
    text += '\n\nGraph changes before the failed step were saved. Fix the error and retry publish.';
  }

  const testResult = applied.find((a) => a.action === 'test_workflow' && a.run);

  if (testResult?.run) {

    text += `\n\n**Test:** ${testResult.run.status}`;

    const failed = (testResult.run.steps || []).filter((s) => s.status === 'failed');

    if (failed.length) {

      text += `\n${failed.map((s) => `- ${s.node_label}: ${s.error_message || 'failed'}`).join('\n')}`;

    }

  }

  if (result?.workflow_triggered) {

    text += `\n\n▶ Run #${result.workflow_triggered.run_number} started.`;

  }

  return text;

}



function buildChatResultPayload({ reply, modelUsed, effectiveWorkflowId, workflow, result, workflowTriggered }) {

  return {

    reply,

    model_used: modelUsed ?? null,

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

          paused: !!workflow.paused,

          chat_trigger_phrase: workflow.chat_trigger_phrase,

        }

      : null,

  };

}



async function executeFastPathCommand(ownerUserId, workflowId, command, actor) {

  const actionMap = {

    trigger_workflow: 'trigger_workflow',

    test_workflow: 'test_workflow',

    open_workflow: 'open_workflow',

    reload_workflow: 'reload_workflow',

    pause_workflow: 'pause_workflow',

    resume_workflow: 'resume_workflow',

    unpublish_workflow: 'unpublish',

    pause_run: 'pause_run',

    stop_run: 'stop_run',

    inspect_run: 'inspect_run',

    pause_all_runs: 'pause_all_runs',

  };

  const actionName = actionMap[command.cmd];

  if (!actionName) return null;



  const action = {

    action: actionName,

    workflow_id: command.workflow_id || workflowId || undefined,

    workflow_name: command.workflow_name,

    run_number: command.run_number,

    input: command.input,

  };



  const result = await applyWorkflowBuilderActions(ownerUserId, workflowId, [action], actor);

  const effectiveWorkflowId = result.workflow_id || workflowId;

  const workflow = effectiveWorkflowId ? store.getDefinition(effectiveWorkflowId, ownerUserId) : null;



  const replies = {

    trigger_workflow: () => {

      const tr = result.results?.find((r) => r.action === 'trigger_workflow');

      return tr ? `Started run #${tr.run_number}.` : 'Triggered.';

    },

    test_workflow: () => {

      const tr = result.results?.find((r) => r.action === 'test_workflow');

      return tr?.run ? `Test run #${tr.run_number}: ${tr.run.status}.` : `Test started #${tr?.run_number}.`;

    },

    open_workflow: () => (workflow ? `Opened "${workflow.name}".` : 'Opened.'),

    reload_workflow: () => (workflow ? `Reloaded "${workflow.name}".` : 'Reloaded.'),

    pause_workflow: () => 'Workflow paused.',

    resume_workflow: () => 'Workflow resumed.',

    unpublish_workflow: () =>

      workflow ? `"${workflow.name}" is now draft (unpublished).` : 'Reverted to draft.',

    pause_run: () => 'Run paused.',

    stop_run: () => 'Run stopped.',

    inspect_run: () => {

      const insp = result.results?.find((r) => r.action === 'inspect_run');

      return insp?.run ? `Run #${insp.run.run_number}: ${insp.run.status}` : 'Inspected.';

    },

    pause_all_runs: () => {

      const pr = result.results?.find((r) => r.action === 'pause_all_runs');

      return `Paused ${pr?.paused ?? 0} run(s).`;

    },

  };



  const reply = (replies[command.cmd] || (() => 'Done.'))();



  let workflowTriggered = null;

  const tr = result.results?.find(

    (r) => ['trigger_workflow', 'test_workflow'].includes(r.action) && r.run_id

  );

  if (tr) {

    workflowTriggered = { run_id: tr.run_id, run_number: tr.run_number, definition_id: tr.definition_id };

  }



  return buildChatResultPayload({

    reply,

    modelUsed: null,

    effectiveWorkflowId,

    workflow,

    result,

    workflowTriggered,

  });

}



export async function runWorkflowBuilderChat({

  ownerUserId,

  workflowId = null,

  message,

  history = [],

  actor = null,

  persist = true,

}) {

  const trimmed = String(message || '').trim();

  if (!trimmed) throw new Error('message required');



  const actorNorm = {

    ...actor,

    id: actor?.id || WORKFLOW_BUILDER_AGENT_ID,

    name: actor?.name || 'Workflow Builder',

  };



  let effectiveHistory = Array.isArray(history) && history.length ? history : [];

  if (!effectiveHistory.length) {

    effectiveHistory = listWorkflowChatTurns(ownerUserId, workflowId, 50).map((t) => ({

      role: t.role,

      content: t.content,

    }));

  }



  const describeResult = tryDescribeWorkflowResponse(ownerUserId, workflowId, trimmed);
  if (describeResult) {
    const assistantText = describeResult.reply;
    if (persist) {
      appendWorkflowChatExchange(ownerUserId, describeResult.workflow_id || workflowId, trimmed, assistantText);
    }
    return {
      ...buildChatResultPayload({
        reply: assistantText,
        modelUsed: null,
        effectiveWorkflowId: describeResult.workflow_id || workflowId,
        workflow: describeResult.workflow,
        result: null,
        workflowTriggered: null,
      }),
      reply: assistantText,
      thread_workflow_id: workflowChatThreadKey(describeResult.workflow_id || workflowId),
    };
  }

  const catalogResult = tryCatalogQueryResponse(trimmed);
  if (catalogResult) {
    const assistantText = catalogResult.reply;
    if (persist) {
      appendWorkflowChatExchange(ownerUserId, workflowId, trimmed, assistantText);
    }
    return {
      ...buildChatResultPayload({
        reply: assistantText,
        modelUsed: null,
        effectiveWorkflowId: workflowId,
        workflow: workflowId ? store.getDefinition(workflowId, ownerUserId) : null,
        result: null,
        workflowTriggered: null,
      }),
      reply: assistantText,
      thread_workflow_id: workflowChatThreadKey(workflowId),
    };
  }

  const fastCommand = parseWorkflowAgentCommand(trimmed, { workflowId });

  if (fastCommand) {

    const fastResult = await executeFastPathCommand(ownerUserId, workflowId, fastCommand, actorNorm);

    if (fastResult) {

      const assistantText = formatAssistantReply(fastResult.reply, fastResult);

      if (persist) {

        appendWorkflowChatExchange(ownerUserId, fastResult.workflow_id || workflowId, trimmed, assistantText);

      }

      return {

        ...fastResult,

        reply: assistantText,

        thread_workflow_id: workflowChatThreadKey(fastResult.workflow_id || workflowId),

      };

    }

  }

  const recipeResult = await executeRecipePath(ownerUserId, workflowId, trimmed, actorNorm);

  if (recipeResult) {

    const assistantText = formatAssistantReply(recipeResult.reply, recipeResult);

    if (persist) {

      appendWorkflowChatExchange(ownerUserId, recipeResult.workflow_id || workflowId, trimmed, assistantText);

    }

    return {

      ...recipeResult,

      reply: assistantText,

      thread_workflow_id: workflowChatThreadKey(recipeResult.workflow_id || workflowId),

    };

  }



  const messages = [

    { role: 'system', content: SYSTEM_PROMPT },

    ...effectiveHistory.slice(-20).map((t) => ({

      role: t.role === 'assistant' ? 'assistant' : 'user',

      content: String(t.content || ''),

    })),

    { role: 'user', content: buildUserContext({ workflowId, ownerUserId, message: trimmed }) },

  ];



  const { content, modelUsed } = await chatCompletions({ messages, maxTokens: 4096 });

  const parsed = parseAgentJson(content);

  const reply = parsed.reply || content;

  let actions = Array.isArray(parsed.actions) ? parsed.actions : [];

  const runtime = buildWorkflowAgentRuntimeContext(ownerUserId);

  actions = enrichCreateWorkflowActions(trimmed, actions, runtime);

  let result = null;

  let effectiveWorkflowId = workflowId;



  if (actions.length) {

    result = await applyWorkflowBuilderActions(ownerUserId, effectiveWorkflowId, actions, actorNorm);

    effectiveWorkflowId = result.workflow_id;

  }



  let workflowTriggered = null;

  if (actions.length && result?.results) {

    const tr = result.results.find((r) =>

      ['trigger_workflow', 'trigger_run', 'test_workflow'].includes(r.action)

    );

    if (tr?.run_id) {

      workflowTriggered = {

        run_id: tr.run_id,

        run_number: tr.run_number,

        definition_id: tr.definition_id,

      };

    }

  }



  const workflow = effectiveWorkflowId ? store.getDefinition(effectiveWorkflowId, ownerUserId) : null;

  const payload = buildChatResultPayload({

    reply,

    modelUsed,

    effectiveWorkflowId,

    workflow,

    result,

    workflowTriggered,

  });

  const assistantText = formatAssistantReply(reply, payload);



  if (persist) {

    appendWorkflowChatExchange(ownerUserId, effectiveWorkflowId || workflowId, trimmed, assistantText);

  }



  return {

    ...payload,

    reply: assistantText,

    thread_workflow_id: workflowChatThreadKey(effectiveWorkflowId || workflowId),

  };

}



export function getWorkflowBuilderChatHistory(ownerUserId, workflowId = null, limit = 100) {

  return listWorkflowChatTurns(ownerUserId, workflowId, limit);

}



export { WORKFLOW_BUILDER_AGENT_ID };


