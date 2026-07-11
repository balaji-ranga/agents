/**
 * Standard workflow task catalog — input/output schemas for built-in tasks.
 */

export const WORKFLOW_TASK_TYPES = {
  trigger: {
    type: 'trigger',
    label: 'Trigger',
    color: '#16a34a',
    inputs: [],
    outputs: [{ id: 'trigger_input', label: 'Trigger payload', description: 'Initial message or schedule context' }],
  },
  agent: {
    type: 'agent',
    label: 'Agent',
    color: '#2563eb',
    inputs: [
      { id: 'prompt', label: 'Task / prompt', required: false, mode: 'dynamic', defaultMode: 'dynamic', description: 'Static text or previous step output via {{input}}' },
    ],
    outputs: [{ id: 'text', label: 'Agent response', description: 'Full agent reply text' }],
  },
  tool: {
    type: 'tool',
    label: 'Content Tool',
    color: '#9333ea',
    inputs: [
      { id: 'payload', label: 'Tool payload', required: false, mode: 'dynamic', description: 'Merged with tool-specific static fields' },
    ],
    outputs: [{ id: 'result', label: 'Tool result', description: 'JSON or text from tool' }],
  },
  mcp_tool: {
    type: 'mcp_tool',
    label: 'MCP',
    color: '#0ea5e9',
    inputs: [
      { id: 'arguments', label: 'Arguments (JSON)', required: false, mode: 'dynamic', description: 'Merged with static args (tools/prompts)' },
      { id: 'uri', label: 'Resource URI', required: false, mode: 'dynamic', description: 'Override resource URI when invoke kind is resource' },
    ],
    outputs: [
      { id: 'text', label: 'Response text' },
      { id: 'result', label: 'Full MCP result JSON' },
      { id: 'ok', label: 'Success' },
    ],
    configFields: [
      { id: 'mcpInvokeKind', label: 'Invoke kind', type: 'select', options: ['tool', 'prompt', 'resource'], default: 'tool' },
      { id: 'mcpServerId', label: 'MCP server', type: 'text' },
      { id: 'toolName', label: 'Tool name', type: 'text' },
      { id: 'promptName', label: 'Prompt name', type: 'text' },
      { id: 'resourceUri', label: 'Resource URI', type: 'text' },
      { id: 'staticArguments', label: 'Static arguments (JSON)', type: 'textarea', placeholder: '{}' },
      { id: 'httpHeadersJson', label: 'HTTP headers (JSON)', type: 'textarea', placeholder: '{}' },
    ],
  },
  mcp_listen: {
    type: 'sse_listen',
    label: 'SSE Listen',
    color: '#0284c7',
    inputs: [],
    outputs: [
      { id: 'event', label: 'Latest SSE event JSON' },
      { id: 'text', label: 'Latest event as text' },
      { id: 'event_count', label: 'Events received' },
      { id: 'last_event_at', label: 'Last event timestamp' },
    ],
    configFields: [
      { id: 'streamUrl', label: 'SSE stream URL (optional)', type: 'text', placeholder: 'https://your-mcp.example.com/events/stream' },
      { id: 'mcpServerId', label: 'MCP server (optional)', type: 'text' },
      { id: 'eventsPath', label: 'Events path (with MCP server)', type: 'text', default: '/events/stream' },
      { id: 'httpHeadersJson', label: 'HTTP headers (JSON)', type: 'textarea', placeholder: '{}' },
    ],
  },
  sse_listen: {
    type: 'sse_listen',
    label: 'SSE Listen',
    color: '#0284c7',
    inputs: [],
    outputs: [
      { id: 'event', label: 'Latest SSE event JSON' },
      { id: 'text', label: 'Latest event as text' },
      { id: 'event_count', label: 'Events received' },
      { id: 'last_event_at', label: 'Last event timestamp' },
    ],
    configFields: [
      { id: 'streamUrl', label: 'SSE stream URL (optional)', type: 'text' },
      { id: 'mcpServerId', label: 'MCP server (optional)', type: 'text' },
      { id: 'eventsPath', label: 'Events path (with MCP server)', type: 'text', default: '/events/stream' },
      { id: 'httpHeadersJson', label: 'HTTP headers (JSON)', type: 'textarea', placeholder: '{}' },
    ],
  },
  sub_workflow: {
    type: 'sub_workflow',
    label: 'Sub-workflow',
    color: '#4f46e5',
    inputs: [],
    outputs: [
      { id: 'run_id', label: 'Child run ID' },
      { id: 'run_number', label: 'Child run number' },
      { id: 'definition_id', label: 'Target workflow ID' },
      { id: 'status', label: 'Child run status' },
      { id: 'text', label: 'Summary' },
      { id: 'ok', label: 'Success' },
    ],
    configFields: [
      { id: 'targetWorkflowId', label: 'Target workflow ID', type: 'text' },
      {
        id: 'triggerMode',
        label: 'Trigger as',
        type: 'select',
        options: ['manual', 'event', 'chat'],
        default: 'manual',
      },
      { id: 'inputTemplate', label: 'Input JSON template', type: 'textarea', placeholder: '{{event}}' },
      { id: 'waitForCompletion', label: 'Wait for child to finish', type: 'boolean', default: false },
    ],
  },
  email: {
    type: 'email',
    label: 'Send Email',
    color: '#dc2626',
    inputs: [
      { id: 'to', label: 'To address', required: true, mode: 'static', placeholder: 'team@example.com' },
      { id: 'cc', label: 'CC', required: false, mode: 'static', placeholder: '' },
      { id: 'subject', label: 'Subject', required: true, mode: 'static', placeholder: 'Job discovery update' },
      { id: 'body', label: 'Email body', required: true, mode: 'dynamic', description: 'Usually from previous agent step output' },
    ],
    outputs: [
      { id: 'sent', label: 'Sent', description: 'true if SMTP accepted the message' },
      { id: 'attempted', label: 'Attempted', description: 'true if send was tried' },
      { id: 'messageId', label: 'Message ID', description: 'SMTP message id when sent' },
      { id: 'error', label: 'Error', description: 'Error message if send failed' },
    ],
    configFields: [
      { id: 'useEnvSmtp', label: 'Use WORKFLOW_SMTP_* from .env', type: 'boolean', default: true },
      { id: 'smtpHost', label: 'SMTP host', type: 'text', placeholder: 'smtp.example.com' },
      { id: 'smtpPort', label: 'SMTP port', type: 'number', default: 587 },
      { id: 'smtpSecure', label: 'TLS / secure', type: 'boolean', default: false },
      { id: 'smtpUser', label: 'SMTP user', type: 'text' },
      { id: 'smtpPass', label: 'SMTP password', type: 'password' },
      { id: 'fromAddress', label: 'From address', type: 'text', placeholder: 'agent-os@example.com' },
    ],
  },
  api: {
    type: 'api',
    label: 'Call API',
    color: '#7c3aed',
    inputs: [
      { id: 'url', label: 'URL', required: true, mode: 'static', placeholder: 'https://api.example.com/hook' },
      { id: 'body', label: 'Request body', required: false, mode: 'dynamic', description: 'JSON or text from previous step' },
      { id: 'headers', label: 'Extra headers (JSON)', required: false, mode: 'static', placeholder: '{}' },
    ],
    outputs: [
      { id: 'status', label: 'HTTP status' },
      { id: 'body', label: 'Response body' },
      { id: 'ok', label: 'Success (2xx)' },
    ],
    configFields: [
      { id: 'method', label: 'HTTP method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'POST' },
      { id: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 60000 },
      { id: 'authType', label: 'Auth type', type: 'select', options: ['none', 'basic', 'bearer', 'api_key'], default: 'none' },
    ],
  },
  externalAgent: {
    type: 'externalAgent',
    label: 'External Agent (A2A)',
    color: '#059669',
    inputs: [
      {
        id: 'message',
        label: 'Message / prompt',
        required: true,
        mode: 'dynamic',
        description: 'Task for the external agent (supports {{input}} and prior step outputs)',
      },
      { id: 'contextId', label: 'Context ID (optional)', required: false, mode: 'static', description: 'A2A conversation context id' },
    ],
    outputs: [
      { id: 'text', label: 'Agent response text' },
      { id: 'result', label: 'Full A2A result JSON' },
      { id: 'task_id', label: 'A2A task ID' },
      { id: 'task_state', label: 'Task state' },
      { id: 'ok', label: 'Success' },
    ],
    configFields: [
      { id: 'externalAgentId', label: 'External agent', type: 'text' },
      { id: 'skillId', label: 'Skill ID (optional)', type: 'text' },
      { id: 'waitForCompletion', label: 'Wait for task completion', type: 'boolean', default: true },
      { id: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 120000 },
    ],
  },
  parallel: {
    type: 'parallel',
    label: 'Parallel',
    color: '#ea580c',
    inputs: [{ id: 'in', label: 'Input', mode: 'dynamic' }],
    outputs: [{ id: 'out', label: 'Branch signal' }],
  },
  merge: {
    type: 'merge',
    label: 'Merge',
    color: '#0891b2',
    inputs: [{ id: 'branches', label: 'Branch inputs', mode: 'dynamic' }],
    outputs: [{ id: 'merged', label: 'Merged context' }],
  },
  ceo_approval: {
    type: 'ceo_approval',
    label: 'CEO Approval',
    color: '#ca8a04',
    inputs: [
      {
        id: 'summary',
        label: 'Summary for CEO',
        required: true,
        mode: 'dynamic',
        description: 'Context shown on Kanban (from previous step)',
      },
    ],
    outputs: [
      { id: 'decision', label: 'Decision', description: 'approved or rejected' },
      { id: 'comment', label: 'CEO comment' },
      { id: 'approved', label: 'Approved (true/false)' },
      { id: 'text', label: 'Full outcome text' },
    ],
    configFields: [
      { id: 'title', label: 'Kanban title', type: 'text', placeholder: 'CEO review required' },
      { id: 'instructions', label: 'Instructions for CEO', type: 'text', placeholder: 'Review and approve or reject' },
    ],
  },
  if: {
    type: 'if',
    label: 'IF',
    color: '#0d9488',
    inputs: [],
    outputs: [
      { id: 'result', label: 'Condition result (true/false)' },
      { id: 'text', label: 'Branch taken' },
    ],
    configFields: [
      { id: 'sourceNodeId', label: 'Source step ID', type: 'text' },
      { id: 'sourceOutputKey', label: 'Output key', type: 'text', default: 'text' },
      {
        id: 'operator',
        label: 'Operator',
        type: 'select',
        options: ['eq', 'ne', 'contains', 'not_contains', 'gt', 'lt', 'empty', 'not_empty', 'approved', 'rejected'],
        default: 'contains',
      },
      { id: 'compareValue', label: 'Compare value', type: 'text' },
    ],
  },
  while: {
    type: 'while',
    label: 'While',
    color: '#db2777',
    inputs: [],
    outputs: [
      { id: 'iterations', label: 'Iteration count' },
      { id: 'text', label: 'Last condition result' },
    ],
    configFields: [
      { id: 'sourceNodeId', label: 'Source step ID', type: 'text' },
      { id: 'sourceOutputKey', label: 'Output key', type: 'text', default: 'text' },
      {
        id: 'operator',
        label: 'Operator',
        type: 'select',
        options: ['eq', 'ne', 'contains', 'not_contains', 'gt', 'lt', 'empty', 'not_empty'],
        default: 'not_empty',
      },
      { id: 'compareValue', label: 'Compare value', type: 'text' },
      { id: 'maxIterations', label: 'Max iterations', type: 'number', default: 10 },
    ],
  },
  brain: {
    type: 'brain',
    label: 'Brain (LLM)',
    color: '#6366f1',
    inputs: [
      { id: 'userMessage', label: 'User message', mode: 'dynamic', description: 'From previous step or static' },
    ],
    outputs: [
      { id: 'text', label: 'LLM response' },
      { id: 'model_used', label: 'Model used' },
      { id: 'provider', label: 'Provider' },
      { id: 'mcp_tools_available', label: 'MCP tools available' },
      { id: 'mcp_tool_calls', label: 'MCP tool calls (JSON)' },
      { id: 'custom_script_ran', label: 'Custom script executed' },
      { id: 'custom_script_output', label: 'Custom script output JSON' },
    ],
    configFields: [
      {
        id: 'modelSource',
        label: 'Model source',
        type: 'select',
        options: ['openai', 'anthropic', 'ollama', 'openrouter'],
        default: 'ollama',
      },
      {
        id: 'apiEndpoint',
        label: 'API endpoint (base URL)',
        type: 'text',
        placeholder: 'https://api.openai.com/v1 or https://openrouter.ai/api/v1',
      },
      { id: 'apiKey', label: 'API key (required on node)', type: 'password' },
      {
        id: 'model',
        label: 'Model name',
        type: 'text',
        placeholder: 'gpt-4o-mini or openai/gpt-4o-mini (OpenRouter)',
      },
      { id: 'maxTokens', label: 'Max tokens', type: 'number', default: 1024 },
      {
        id: 'systemPrompt',
        label: 'System prompt',
        type: 'textarea',
        placeholder: 'You are a helpful assistant. Context: {{brain-1.text}}',
      },
      { id: 'mcpToolCalling', label: 'Let LLM call MCP tools', type: 'boolean', default: false },
      { id: 'mcpServerIds', label: 'MCP server IDs (JSON array)', type: 'textarea', placeholder: '[]' },
      { id: 'mcpToolAllowlist', label: 'MCP tool allowlist (JSON array)', type: 'textarea', placeholder: '[]' },
      { id: 'mcpMaxToolRounds', label: 'Max MCP tool rounds', type: 'number', default: 8 },
      { id: 'mcpServerAuth', label: 'Per-MCP auth (JSON object)', type: 'textarea', placeholder: '{}' },
      {
        id: 'customScriptMode',
        label: 'Custom script mode',
        type: 'select',
        options: ['off', 'fallback', 'post', 'only'],
        default: 'off',
      },
      { id: 'customScriptId', label: 'Custom script ID', type: 'text', placeholder: 'script-my-graph-abc123' },
    ],
  },
  custom_script: {
    type: 'custom_script',
    label: 'Custom Script',
    color: '#b45309',
    inputs: [
      {
        id: 'payload',
        label: 'Input payload',
        required: false,
        mode: 'dynamic',
        description: 'JSON or text passed to run_graph(inputs) / run(inputs)',
      },
    ],
    outputs: [
      { id: 'text', label: 'Script text output' },
      { id: 'result', label: 'Full script result JSON' },
      { id: 'ok', label: 'Success' },
      { id: 'script_id', label: 'Script ID' },
    ],
    configFields: [
      { id: 'customScriptId', label: 'Custom script', type: 'text' },
      { id: 'customScriptName', label: 'Script name (display)', type: 'text' },
    ],
  },
};

export function getTaskCatalog() {
  return Object.values(WORKFLOW_TASK_TYPES);
}

export function getTaskTypeDef(type) {
  return WORKFLOW_TASK_TYPES[type] || null;
}

/** Default input bindings for a new node of given type. */
export function defaultInputBindings(type) {
  const def = getTaskTypeDef(type);
  if (!def?.inputs?.length) return [];
  return def.inputs.map((inp) => ({
    id: inp.id,
    label: inp.label,
    mode: inp.defaultMode || inp.mode || 'static',
    value: inp.mode === 'static' ? '' : undefined,
    sourceNodeId: '',
    sourceOutputKey: 'text',
  }));
}

export function defaultNodeConfig(type) {
  const def = getTaskTypeDef(type);
  const config = {};
  for (const f of def?.configFields || []) {
    config[f.id] = f.default ?? (f.type === 'boolean' ? false : f.type === 'number' ? f.default || 0 : '');
  }
  if (type === 'api') {
    config.method = config.method || 'POST';
    config.timeoutMs = config.timeoutMs || 60000;
  }
  if (type === 'email') {
    config.useEnvSmtp = config.useEnvSmtp !== false;
    config.smtpPort = config.smtpPort || 587;
  }
  return config;
}

export function defaultOutputsList(type) {
  return (getTaskTypeDef(type)?.outputs || []).map((o) => ({ ...o }));
}
