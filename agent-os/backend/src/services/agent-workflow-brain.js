/**
 * Brain node — direct LLM invocation (Anthropic, OpenAI, Ollama).
 */

function isLocalOllama(baseUrl) {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(url) {
  if (!url) return '';
  const u = String(url).trim().replace(/\/$/, '');
  if (u.endsWith('/chat/completions')) return u.replace(/\/chat\/completions$/, '');
  if (u.endsWith('/messages')) return u.replace(/\/messages$/, '');
  return u;
}

/** Primary input for Brain {{input}} — trigger payload, then bound inputs (same priority as user message). */
export function resolveBrainInputPlaceholder(context, resolved = {}) {
  const initial = String(context?.initial_input || '').trim();
  if (initial) return initial;
  if (resolved.userMessage) return String(resolved.userMessage);
  if (resolved.prompt) return String(resolved.prompt);
  if (resolved.body) return String(resolved.body);
  const first = Object.entries(resolved)
    .filter(([k, v]) => v && !['systemPrompt'].includes(k))
    .map(([, v]) => String(v).trim())
    .find(Boolean);
  return first || '';
}

/** Replace {{input}}, {{nodeId.outputKey}} bind variables in system prompt. */
export function renderBrainPrompt(template, context, graph, resolved = {}) {
  if (!template) return '';
  let out = String(template);
  out = out.replace(/\{\{input\}\}/g, resolveBrainInputPlaceholder(context, resolved));
  out = out.replace(/\{\{([\w.-]+)\.([\w.-]+)\}\}/g, (_, nodeId, key) => {
    const raw = context.node_outputs?.[nodeId];
    if (raw == null) return '';
    if (typeof raw === 'object' && key in raw) return String(raw[key] ?? '');
    if (key === 'text' && typeof raw === 'string') return raw;
    if (typeof raw === 'object' && raw.text != null) return String(raw.text);
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  });
  return out;
}

function buildUserMessage(resolved) {
  if (resolved.userMessage) return resolved.userMessage;
  if (resolved.prompt) return resolved.prompt;
  if (resolved.body) return resolved.body;
  const parts = Object.entries(resolved)
    .filter(([k, v]) => v && !['systemPrompt'].includes(k))
    .map(([k, v]) => `${k}:\n${v}`);
  return parts.join('\n\n') || '(no input)';
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, systemPrompt, userMessage, maxTokens, provider = 'openai' }) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const messages = [];
  if (systemPrompt?.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
  messages.push({ role: 'user', content: userMessage });
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error || res.statusText);
  const content = data?.choices?.[0]?.message?.content ?? '';
  return { text: typeof content === 'string' ? content : String(content), model_used: model, provider };
}

async function callAnthropic({ baseUrl, apiKey, model, systemPrompt, userMessage, maxTokens }) {
  const url = `${normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1')}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt?.trim() || undefined,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error?.type || res.statusText);
  const block = data?.content?.find((c) => c.type === 'text');
  const text = block?.text ?? '';
  return { text, model_used: model, provider: 'anthropic' };
}

async function callMcpTools(mcpEndpoints, userMessage) {
  const results = [];
  const list = Array.isArray(mcpEndpoints) ? mcpEndpoints : [];
  for (const ep of list) {
    const url = typeof ep === 'string' ? ep : ep?.url;
    if (!url) continue;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMessage }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.text();
      results.push({ url, status: res.status, body: body.slice(0, 4000) });
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }
  return results;
}

/**
 * @param {object} taskConfig - node.data.taskConfig
 * @param {object} resolved - resolved input bindings
 * @param {object} context - workflow run context
 * @param {object} graph - workflow graph
 */
export async function executeBrainTask(taskConfig = {}, resolved = {}, context = {}, graph = {}) {
  const cfg = taskConfig || {};
  const modelSource = (cfg.modelSource || 'openai').toLowerCase();
  const maxTokens = Number(cfg.maxTokens) || 1024;

  let baseUrl = cfg.apiEndpoint || '';
  let apiKey = cfg.apiKey || '';
  let model = cfg.model || '';

  if (modelSource === 'ollama') {
    baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
    model = model || process.env.OLLAMA_MODEL || 'llama3.2';
    if (!apiKey) apiKey = 'ollama';
  } else if (modelSource === 'anthropic') {
    baseUrl = baseUrl || 'https://api.anthropic.com/v1';
    apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    model = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    if (!apiKey) throw new Error('Anthropic API key required (node config or ANTHROPIC_API_KEY)');
  } else {
    baseUrl = baseUrl || process.env.OPENAI_BASE_URL || process.env.OPENAI_PRIMARY_BASE_URL || 'https://api.openai.com/v1';
    apiKey = apiKey || process.env.OPENAI_API_KEY || process.env.OPENAI_PRIMARY_API_KEY || '';
    model = model || process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o-mini';
    if (!apiKey && !isLocalOllama(baseUrl)) throw new Error('OpenAI API key required');
  }

  const systemPrompt = renderBrainPrompt(cfg.systemPrompt || '', context, graph, resolved);
  let userMessage = buildUserMessage(resolved);

  const mcpEndpoints = cfg.mcpEndpoints || [];
  if (mcpEndpoints.length) {
    const mcpResults = await callMcpTools(mcpEndpoints, userMessage);
    userMessage += `\n\n--- MCP tool results ---\n${JSON.stringify(mcpResults, null, 2)}`;
  }

  const openAiProvider = modelSource === 'ollama' || isLocalOllama(baseUrl) ? 'ollama' : 'openai';

  let result;
  if (modelSource === 'anthropic') {
    result = await callAnthropic({ baseUrl, apiKey, model, systemPrompt, userMessage, maxTokens });
  } else {
    result = await callOpenAiCompatible({
      baseUrl,
      apiKey,
      model,
      systemPrompt,
      userMessage,
      maxTokens,
      provider: openAiProvider,
    });
  }

  return {
    text: result.text,
    model_used: result.model_used,
    provider: result.provider,
    system_prompt_rendered: systemPrompt.slice(0, 500),
  };
}
