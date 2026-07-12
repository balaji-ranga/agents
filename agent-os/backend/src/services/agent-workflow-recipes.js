/**
 * Curated workflow recipes — turn high-level intent into a full action batch (like Cursor e2e setup).
 */
import { buildBrainApprovalTestGraph } from '../../scripts/seed-brain-approval-workflow.js';
import { buildBrainMcpLoopGraph } from '../../scripts/seed-brain-mcp-loop-workflow.js';
import { JOB_APPLICANT_TEMPLATE_ID, JOB_APPLICANT_CHAT_PHRASE } from './agent-workflow-templates.js';
import { defaultBrainConfig } from './agent-workflow-agent-runtime-context.js';
import { BRAIN_PROVIDERS } from './agent-workflow-brain-providers.js';

function slugify(name) {
  return String(name || 'workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function extractWorkflowName(message) {
  const t = String(message || '');
  let m = t.match(/(?:called|named)\s+["']([^"']+)["']/i);
  if (m) return m[1].trim();
  m = t.match(/(?:called|named)\s+([^"'\n.]+?)(?:\s*[.,]|\s+(?:get|make|trigger|set|use|with)\b)/i);
  if (m) return m[1].trim();
  m = t.match(/(?:called|named)\s+["']?([^"'\n]+?)["']?\s*$/i);
  if (m) return m[1].trim();
  m = t.match(/workflow\s*:\s*(.+)$/i);
  if (m) return m[1].trim().slice(0, 80);
  return null;
}

export function inferTriggerModes(message) {
  const t = String(message || '').toLowerCase();
  const modes = [];
  if (/\bmanual(?:ly)?\b/i.test(t)) modes.push('manual');
  if (/\bchat\b/i.test(t)) modes.push('chat');
  if (/\bschedule|cron\b/i.test(t)) modes.push('schedule');
  if (/\bevent|webhook|hook\b/i.test(t)) modes.push('event');
  return modes.length ? modes : ['manual', 'chat'];
}

function openRouterBrainConfig() {
  const preset = BRAIN_PROVIDERS.openrouter;
  return {
    ...defaultBrainConfig(),
    modelSource: 'openrouter',
    apiEndpoint: preset.baseUrl,
    apiKey: '',
    model: preset.model,
    maxTokens: 512,
    systemPrompt: 'You are a helpful assistant. Respond clearly and concisely.\n\nUser input:\n{{input}}',
    mcpToolCalling: false,
    mcpServerIds: [],
  };
}

function apiEchoNode(id, label, x, y, bodySourceNodeId, bodySourceKey = 'text') {
  return {
    id,
    type: 'api',
    position: { x, y },
    data: {
      label,
      inputBindings: [
        { id: 'url', label: 'URL', mode: 'static', value: 'https://postman-echo.com/post' },
        {
          id: 'body',
          label: 'Request body',
          mode: 'dynamic',
          sourceNodeId: bodySourceNodeId,
          sourceOutputKey: bodySourceKey,
          value: '',
        },
        { id: 'headers', label: 'Headers', mode: 'static', value: '{"Content-Type":"application/json"}' },
      ],
      outputs: [
        { id: 'status', label: 'HTTP status' },
        { id: 'body', label: 'Response body' },
        { id: 'ok', label: 'Success' },
      ],
      taskConfig: { method: 'POST', authType: 'none', timeoutMs: 1200000, timeoutAction: 'fail', defaultTimeoutOutput: '{}' },
    },
  };
}

function wantsAutoTest(message) {
  return /\b(test|e2e|verify|working|validate)\b/i.test(String(message || ''));
}

export const WORKFLOW_RECIPES = [
  {
    id: 'brain-ceo-approval',
    label: 'Brain → CEO Approval → If approved',
    score(message) {
      const t = message.toLowerCase();
      let s = 0;
      if (/brain/i.test(t)) s += 2;
      if (/ceo|approval|kanban|approve/i.test(t)) s += 3;
      if (/summar/i.test(t)) s += 1;
      if (/→|->|then/i.test(t)) s += 1;
      return s;
    },
    build(message, ctx) {
      const name = extractWorkflowName(message) || 'Brain + CEO Approval';
      const phrase = `run ${slugify(name)}`;
      const graph = buildBrainApprovalTestGraph();
      graph.nodes.find((n) => n.id === 'trigger-1').data.chatPhrase = phrase;
      return {
        name,
        chat_phrase: phrase,
        graph,
        autoTest: wantsAutoTest(message),
        summary: 'Brain drafts summary → CEO Kanban approval → if approved branch',
      };
    },
  },
  {
    id: 'brain-mcp-loop',
    label: 'Brain with MCP tool-calling',
    score(message) {
      const t = message.toLowerCase();
      let s = 0;
      if (/brain/i.test(t)) s += 2;
      if (/mcp/i.test(t)) s += 3;
      if (/tool.?call|random|sse/i.test(t)) s += 2;
      return s;
    },
    build(message, ctx) {
      const name = extractWorkflowName(message) || 'Brain MCP Loop';
      const mcpId = ctx?.defaults?.firstMcpId;
      let graph = buildBrainMcpLoopGraph();
      if (mcpId) {
        const brain = graph.nodes.find((n) => n.id === 'brain-1');
        if (brain?.data?.taskConfig) {
          brain.data.taskConfig.mcpServerIds = [mcpId];
        }
      }
      const phrase = `run ${slugify(name)}`;
      const trigger = graph.nodes.find((n) => n.id === 'trigger-1');
      if (trigger?.data) {
        trigger.data.triggerModes = ['manual', 'chat'];
        trigger.data.chatPhrase = phrase;
      }
      return {
        name,
        chat_phrase: phrase,
        graph,
        autoTest: wantsAutoTest(message),
        summary: 'Brain with MCP tool-calling loop (uses first healthy MCP server)',
      };
    },
  },
  {
    id: 'brain-summarize',
    label: 'Trigger → Brain summarize',
    score(message) {
      const t = message.toLowerCase();
      if (/brain/i.test(t) && /summar/i.test(t) && !/ceo|approval|mcp/i.test(t)) return 5;
      if (/brain/i.test(t) && !/ceo|approval|mcp|agent/i.test(t)) return 2;
      return 0;
    },
    build(message, ctx) {
      const name = extractWorkflowName(message) || 'Brain Summarize';
      const phrase = `run ${slugify(name)}`;
      const brainCfg = { ...defaultBrainConfig(), maxTokens: 256, systemPrompt: 'Summarize the input in 2-3 sentences.\n\n{{input}}' };
      return {
        name,
        chat_phrase: phrase,
        graph: {
          nodes: [
            {
              id: 'trigger-1',
              type: 'trigger',
              position: { x: 40, y: 120 },
              data: { label: 'Start', triggerModes: ['manual', 'chat'], chatPhrase: phrase, scheduleCron: '' },
            },
            {
              id: 'brain-1',
              type: 'brain',
              position: { x: 260, y: 120 },
              data: {
                label: 'Summarize',
                inputBindings: [
                  { id: 'userMessage', label: 'User message', mode: 'dynamic', sourceNodeId: 'trigger-1', sourceOutputKey: 'text' },
                ],
                taskConfig: brainCfg,
              },
            },
          ],
          edges: [{ id: 'e1', source: 'trigger-1', target: 'brain-1' }],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        autoTest: wantsAutoTest(message),
        summary: 'Simple trigger → brain summarize chain',
      };
    },
  },
  {
    id: 'brain-content-guardrail',
    label: 'Trigger → Brain content guardrail',
    score(message) {
      const t = message.toLowerCase();
      let s = 0;
      if (/brain/i.test(t)) s += 2;
      if (/guardrail|content\s+safety|safe\s+content|moderation|filter/i.test(t)) s += 3;
      if (/sexual|abusive|harmful|hate|nsfw|profan/i.test(t)) s += 3;
      if (/system\s*prompt/i.test(t)) s += 1;
      return s;
    },
    build(message, ctx) {
      const name = extractWorkflowName(message) || 'Content Guardrail';
      const phrase = `run ${slugify(name)}`;
      const brainCfg = {
        ...defaultBrainConfig(),
        maxTokens: 512,
        systemPrompt:
          'You are a content safety filter. Review user requests and your responses. Reject, refuse, or rewrite any sexual, abusive, hateful, violent, or harmful content. Respond with safe, professional language only.\n\nUser input:\n{{input}}',
      };
      return {
        name,
        chat_phrase: phrase,
        graph: {
          nodes: [
            {
              id: 'trigger-1',
              type: 'trigger',
              position: { x: 40, y: 120 },
              data: { label: 'Start', triggerModes: ['manual', 'chat'], chatPhrase: phrase, scheduleCron: '' },
            },
            {
              id: 'brain-1',
              type: 'brain',
              position: { x: 260, y: 120 },
              data: {
                label: 'Content Guardrail',
                inputBindings: [
                  { id: 'userMessage', label: 'User message', mode: 'dynamic', sourceNodeId: 'trigger-1', sourceOutputKey: 'text' },
                ],
                taskConfig: brainCfg,
              },
            },
          ],
          edges: [{ id: 'e1', source: 'trigger-1', target: 'brain-1' }],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        autoTest: wantsAutoTest(message),
        summary: 'Trigger → Brain with content-safety system prompt (ollama default)',
      };
    },
  },
  {
    id: 'job-applicant-template',
    label: 'Job Applicant Pipeline (template)',
    score(message) {
      const t = message.toLowerCase();
      if (/job\s+applicant|applicant\s+pipeline|job\s+pipeline/i.test(t)) return 8;
      if (/job\s+discovery.*fit|discovery.*scoring.*resume/i.test(t)) return 6;
      return 0;
    },
    build(message) {
      const name = extractWorkflowName(message) || 'Job Applicant Pipeline';
      return {
        name,
        template_id: JOB_APPLICANT_TEMPLATE_ID,
        chat_phrase: JOB_APPLICANT_CHAT_PHRASE,
        autoTest: false,
        summary: 'Full job applicant pipeline from built-in template',
      };
    },
  },
  {
    id: 'brain-openrouter-api-echo',
    label: 'Brain (OpenRouter) → API echo',
    score(message) {
      const t = message.toLowerCase();
      let s = 0;
      if (/brain/i.test(t)) s += 2;
      if (/openrouter|open\s*router/i.test(t)) s += 5;
      if (/\bapi\b/i.test(t)) s += 2;
      if (/echo/i.test(t)) s += 3;
      if (/after\s+brain|invoke.*api|api\s+after/i.test(t)) s += 2;
      return s;
    },
    build(message) {
      const name = extractWorkflowName(message) || 'Brain OpenRouter API Echo';
      const phrase = `run ${slugify(name)}`;
      const modes = inferTriggerModes(message);
      const brainCfg = openRouterBrainConfig();
      return {
        name,
        chat_phrase: phrase,
        trigger_modes: modes,
        graph: {
          nodes: [
            {
              id: 'trigger-1',
              type: 'trigger',
              position: { x: 40, y: 120 },
              data: {
                label: 'Start',
                triggerModes: modes,
                scheduleCron: '',
                chatPhrase: modes.includes('chat') ? phrase : '',
                inputBindings: [],
                outputs: [{ id: 'trigger_input', label: 'Trigger payload' }],
              },
            },
            {
              id: 'brain-1',
              type: 'brain',
              position: { x: 260, y: 120 },
              data: {
                label: 'Brain (OpenRouter)',
                inputBindings: [
                  {
                    id: 'userMessage',
                    label: 'User message',
                    mode: 'dynamic',
                    sourceNodeId: 'trigger-1',
                    sourceOutputKey: 'text',
                  },
                ],
                taskConfig: brainCfg,
              },
            },
            apiEchoNode('api-1', 'Echo brain response', 480, 120, 'brain-1', 'text'),
          ],
          edges: [
            { id: 'e1', source: 'trigger-1', target: 'brain-1' },
            { id: 'e2', source: 'brain-1', target: 'api-1' },
          ],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        autoTest: wantsAutoTest(message),
        summary: 'Trigger → Brain (OpenRouter) → Postman echo API with brain text as body',
      };
    },
  },
  {
    id: 'brain-api-echo',
    label: 'Brain → API echo',
    score(message) {
      const t = message.toLowerCase();
      if (/openrouter|open\s*router/i.test(t)) return 0;
      let s = 0;
      if (/brain/i.test(t)) s += 2;
      if (/\bapi\b/i.test(t)) s += 2;
      if (/echo/i.test(t)) s += 3;
      if (/after\s+brain|invoke.*api|api\s+after/i.test(t)) s += 2;
      return s;
    },
    build(message, ctx) {
      const name = extractWorkflowName(message) || 'Brain API Echo';
      const phrase = `run ${slugify(name)}`;
      const modes = inferTriggerModes(message);
      const brainCfg = { ...defaultBrainConfig(), maxTokens: 512, systemPrompt: 'Respond helpfully.\n\n{{input}}' };
      return {
        name,
        chat_phrase: phrase,
        trigger_modes: modes,
        graph: {
          nodes: [
            {
              id: 'trigger-1',
              type: 'trigger',
              position: { x: 40, y: 120 },
              data: {
                label: 'Start',
                triggerModes: modes,
                chatPhrase: modes.includes('chat') ? phrase : '',
                scheduleCron: '',
              },
            },
            {
              id: 'brain-1',
              type: 'brain',
              position: { x: 260, y: 120 },
              data: {
                label: 'Brain',
                inputBindings: [
                  { id: 'userMessage', label: 'User message', mode: 'dynamic', sourceNodeId: 'trigger-1', sourceOutputKey: 'text' },
                ],
                taskConfig: brainCfg,
              },
            },
            apiEchoNode('api-1', 'Echo brain response', 480, 120, 'brain-1', 'text'),
          ],
          edges: [
            { id: 'e1', source: 'trigger-1', target: 'brain-1' },
            { id: 'e2', source: 'brain-1', target: 'api-1' },
          ],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        autoTest: wantsAutoTest(message),
        summary: 'Trigger → Brain → API echo (postman-echo.com)',
      };
    },
  },
  {
    id: 'mcp-tool-single',
    label: 'Trigger → MCP tool call',
    score(message) {
      const t = message.toLowerCase();
      if (/mcp/i.test(t) && /tool|call|invoke/i.test(t) && !/brain|listen|sse/i.test(t)) return 5;
      return 0;
    },
    build(message, ctx) {
      const mcp = ctx?.mcpServers?.[0];
      const toolName = mcp?.tools?.[0] || 'get_random_number';
      const name = extractWorkflowName(message) || `MCP ${mcp?.name || 'Tool'} Test`;
      const phrase = `run ${slugify(name)}`;
      return {
        name,
        chat_phrase: phrase,
        graph: {
          nodes: [
            {
              id: 'trigger-1',
              type: 'trigger',
              position: { x: 40, y: 120 },
              data: { label: 'Start', triggerModes: ['manual', 'chat'], chatPhrase: phrase },
            },
            {
              id: 'mcp-1',
              type: 'mcp_tool',
              position: { x: 280, y: 120 },
              data: {
                label: 'MCP Tool',
                inputBindings: [],
                taskConfig: {
                  mcpInvokeKind: 'tool',
                  mcpServerId: mcp?.id || '',
                  toolName,
                  staticArguments: '{}',
                  httpHeadersJson: '{}',
                },
              },
            },
          ],
          edges: [{ id: 'e1', source: 'trigger-1', target: 'mcp-1' }],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        autoTest: wantsAutoTest(message),
        summary: `MCP tool ${toolName} on ${mcp?.id || 'first server'}`,
      };
    },
  },
];

export function isWorkflowCreateIntent(message) {
  const t = String(message || '').trim();
  if (!t) return false;
  return (
    /(?:create|build|make|add|new|setup|set\s+up)\s+(?:a\s+)?(?:new\s+)?workflow/i.test(t) ||
    /^workflow\s*:/i.test(t) ||
    (/(?:brain|mcp|approval|agent|email|sse|api|openrouter)/i.test(t) &&
      /(?:→|->|then|workflow|trigger|provider|invoke|echo)/i.test(t))
  );
}

export function matchWorkflowRecipe(message, { minScore = 4 } = {}) {
  if (!isWorkflowCreateIntent(message)) return null;
  let best = null;
  let bestScore = 0;
  for (const recipe of WORKFLOW_RECIPES) {
    const s = recipe.score(message);
    if (s > bestScore) {
      bestScore = s;
      best = recipe;
    }
  }
  return bestScore >= minScore ? best : null;
}

export function buildRecipeActionBatch(recipe, message, runtime) {
  const spec = recipe.build(message, runtime);
  const actions = [];

  if (spec.template_id) {
    actions.push({
      action: 'create_from_template',
      template_id: spec.template_id,
      name: spec.name,
      chat_phrase: spec.chat_phrase,
    });
  } else {
    actions.push({
      action: 'create_workflow',
      name: spec.name,
      chat_phrase: spec.chat_phrase,
      trigger_modes: spec.trigger_modes || ['manual', 'chat'],
      graph: spec.graph,
    });
  }

  actions.push({ action: 'publish' });

  if (spec.autoTest) {
    actions.push({
      action: 'test_workflow',
      input: 'Automated recipe test run',
      wait: true,
      timeout_ms: 60000,
    });
  }

  return { actions, spec };
}

/** When the LLM only emits create_workflow with a bare trigger, substitute a matching recipe graph. */
export function enrichCreateWorkflowActions(message, actions, runtime) {
  const list = Array.isArray(actions) ? [...actions] : [];
  const createAction = list.find((a) => a.action === 'create_workflow');
  if (!createAction) return list;

  const nodeCount = createAction.graph?.nodes?.length || 0;
  const hasFollowUpNodes = list.some((a) =>
    ['add_node', 'update_node', 'add_edge', 'connect', 'connect_nodes'].includes(a.action)
  );
  if (nodeCount > 1 || hasFollowUpNodes) return list;

  const recipe = matchWorkflowRecipe(message, { minScore: 4 });
  if (!recipe) return list;

  const { actions: recipeActions, spec } = buildRecipeActionBatch(recipe, message, runtime);
  if (createAction.name) recipeActions[0].name = createAction.name;
  if (createAction.chat_phrase || createAction.chat_trigger_phrase) {
    recipeActions[0].chat_phrase = createAction.chat_phrase || createAction.chat_trigger_phrase;
  }
  const keepPublish = list.some((a) => a.action === 'publish');
  const keepTest = list.find((a) => a.action === 'test_workflow');
  const out = [recipeActions[0]];
  if (keepPublish || recipeActions.some((a) => a.action === 'publish')) {
    out.push({ action: 'publish' });
  }
  if (keepTest) out.push(keepTest);
  else if (recipeActions.some((a) => a.action === 'test_workflow')) {
    out.push(recipeActions.find((a) => a.action === 'test_workflow'));
  }
  return out;
}
