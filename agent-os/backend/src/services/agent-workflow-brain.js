/**
 * Brain node — direct LLM invocation (Anthropic, OpenAI, Ollama, OpenRouter).
 * Optional MCP tool-calling loop when mcpToolCalling is enabled.
 */

import { resolveWorkflowBrainProviderConfig } from './agent-workflow-brain-providers.js';
import {
  buildMcpToolRegistry,
  dispatchToolCall,
  entriesToAnthropicTools,
  entriesToOpenAiTools,
  parseBrainMcpConfig,
} from './agent-workflow-brain-mcp.js';
import { executeCustomScript } from './custom-scripts.js';

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

function parseToolArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

async function callOpenAiCompatible({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  userMessage,
  maxTokens,
  provider = 'openai',
  extraHeaders = {},
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
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

async function runOpenAiWithMcpTools({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  userMessage,
  maxTokens,
  provider,
  extraHeaders,
  openAiTools,
  entries,
  authUser,
  serverAuthMap,
  legacyAuth,
  maxRounds,
}) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const messages = [];
  if (systemPrompt?.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
  messages.push({ role: 'user', content: userMessage });

  const toolCallLog = [];
  for (let round = 0; round < maxRounds; round++) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages,
        tools: openAiTools,
        tool_choice: 'auto',
      }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || res.statusText);

    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('No message from LLM');

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      const content = msg.content ?? '';
      return {
        text: typeof content === 'string' ? content : String(content),
        model_used: model,
        provider,
        toolCallLog,
      };
    }

    messages.push(msg);
    for (const tc of toolCalls) {
      const ref = tc.function?.name;
      const args = parseToolArguments(tc.function?.arguments);
      const { log, content } = await dispatchToolCall(ref, args, entries, authUser, serverAuthMap, legacyAuth);
      toolCallLog.push(log);
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
    }
  }

  throw new Error(`MCP tool loop exceeded ${maxRounds} rounds`);
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

async function runAnthropicWithMcpTools({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  userMessage,
  maxTokens,
  anthropicTools,
  entries,
  authUser,
  serverAuthMap,
  legacyAuth,
  maxRounds,
}) {
  const url = `${normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1')}/messages`;
  const messages = [{ role: 'user', content: userMessage }];
  const toolCallLog = [];

  for (let round = 0; round < maxRounds; round++) {
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
        messages,
        tools: anthropicTools,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error?.type || res.statusText);

    const content = data?.content || [];
    const toolUses = content.filter((b) => b.type === 'tool_use');
    const textBlock = content.find((b) => b.type === 'text');

    if (!toolUses.length) {
      return {
        text: textBlock?.text ?? '',
        model_used: model,
        provider: 'anthropic',
        toolCallLog,
      };
    }

    messages.push({ role: 'assistant', content });

    const toolResults = [];
    for (const tu of toolUses) {
      const args = parseToolArguments(tu.input);
      const { log, content: resultContent } = await dispatchToolCall(tu.name, args, entries, authUser, serverAuthMap, legacyAuth);
      toolCallLog.push(log);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultContent,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(`MCP tool loop exceeded ${maxRounds} rounds`);
}

function appendMcpToolsHint(systemPrompt, entries) {
  if (!entries.length) return systemPrompt;
  const lines = entries.map((e) => `- ${e.ref}: ${e.serverName} / ${e.toolName}`);
  const hint =
    'You have MCP tools available. Call them when you need external data or actions. ' +
    'Available tools:\n' +
    lines.join('\n');
  return systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${hint}` : hint;
}

/**
 * @param {object} taskConfig - node.data.taskConfig
 * @param {object} resolved - resolved input bindings
 * @param {object} context - workflow run context
 * @param {object} graph - workflow graph
 * @param {{ authUser?: object }} options - workflow owner for MCP registry access
 */
export async function executeBrainTask(taskConfig = {}, resolved = {}, context = {}, graph = {}, options = {}) {
  const cfg = taskConfig || {};
  const { authUser } = options;
  const scriptMode = String(cfg.customScriptMode || 'off').toLowerCase();
  const scriptId = cfg.customScriptId?.trim() || '';
  const userMessage = buildUserMessage(resolved);

  async function runCustomScriptHook(llmResult = null, reason = 'post') {
    if (!scriptId || !authUser) return null;
    const scriptInputs = {
      userMessage,
      resolved,
      llm_text: llmResult?.text || '',
      llm_provider: llmResult?.provider || '',
      reason,
    };
    const scriptContext = {
      workflow: context?.definition_id || null,
      run_id: context?.run_id || null,
      node_outputs: context?.node_outputs || {},
      initial_input: context?.initial_input || '',
    };
    const run = await executeCustomScript(scriptId, authUser, {
      inputs: scriptInputs,
      context: scriptContext,
    });
    return run.output || {};
  }

  if (scriptMode === 'only' && scriptId) {
    const scriptOut = await runCustomScriptHook(null, 'only');
    const text = scriptOut.text != null ? String(scriptOut.text) : JSON.stringify(scriptOut);
    return {
      text,
      model_used: 'custom_script',
      provider: 'custom_script',
      system_prompt_rendered: '',
      mcp_tools_available: 0,
      mcp_tool_calls: [],
      custom_script_ran: true,
      custom_script_output: scriptOut,
    };
  }

  const maxTokens = Number(cfg.maxTokens) || 1024;
  const { source: modelSource, baseUrl, apiKey, model, protocol, requiresKey, extraHeaders, configuredKey } =
    resolveWorkflowBrainProviderConfig(cfg.modelSource, cfg);

  if (requiresKey && !configuredKey && !isLocalOllama(baseUrl)) {
    const keyHint =
      modelSource === 'openrouter'
        ? 'OpenRouter API key required on Brain node (platform .env keys are not used)'
        : modelSource === 'anthropic'
          ? 'Anthropic API key required on Brain node (platform .env keys are not used)'
          : 'OpenAI API key required on Brain node (platform .env keys are not used)';
    throw new Error(keyHint);
  }

  const mcpCfg = parseBrainMcpConfig(cfg);
  let mcpEntries = [];
  if (mcpCfg.enabled && authUser && mcpCfg.serverIds.length) {
    mcpEntries = buildMcpToolRegistry(mcpCfg.serverIds, mcpCfg.allowlist, authUser);
  }

  let systemPrompt = renderBrainPrompt(cfg.systemPrompt || '', context, graph, resolved);

  if (mcpEntries.length) {
    systemPrompt = appendMcpToolsHint(systemPrompt, mcpEntries);
  }

  let result;
  try {
  if (mcpEntries.length) {
    if (protocol === 'anthropic') {
      result = await runAnthropicWithMcpTools({
        baseUrl,
        apiKey,
        model,
        systemPrompt,
        userMessage,
        maxTokens,
        anthropicTools: entriesToAnthropicTools(mcpEntries),
        entries: mcpEntries,
        authUser,
        serverAuthMap: mcpCfg.serverAuthMap,
        legacyAuth: mcpCfg.legacyAuth,
        maxRounds: mcpCfg.maxRounds,
      });
    } else {
      const openAiProvider =
        modelSource === 'openrouter'
          ? 'openrouter'
          : modelSource === 'ollama' || isLocalOllama(baseUrl)
            ? 'ollama'
            : 'openai';
      result = await runOpenAiWithMcpTools({
        baseUrl,
        apiKey,
        model,
        systemPrompt,
        userMessage,
        maxTokens,
        provider: openAiProvider,
        extraHeaders,
        openAiTools: entriesToOpenAiTools(mcpEntries),
        entries: mcpEntries,
        authUser,
        serverAuthMap: mcpCfg.serverAuthMap,
        legacyAuth: mcpCfg.legacyAuth,
        maxRounds: mcpCfg.maxRounds,
      });
    }
  } else if (protocol === 'anthropic') {
    result = await callAnthropic({ baseUrl, apiKey, model, systemPrompt, userMessage, maxTokens });
  } else {
    const openAiProvider =
      modelSource === 'openrouter'
        ? 'openrouter'
        : modelSource === 'ollama' || isLocalOllama(baseUrl)
          ? 'ollama'
          : 'openai';
    result = await callOpenAiCompatible({
      baseUrl,
      apiKey,
      model,
      systemPrompt,
      userMessage,
      maxTokens,
      provider: openAiProvider,
      extraHeaders,
    });
  }

  let customScriptOut = null;
  let customScriptRan = false;

  if (scriptMode === 'post' && scriptId) {
    customScriptOut = await runCustomScriptHook(result, 'post');
    customScriptRan = true;
    if (customScriptOut?.text) {
      result = { ...result, text: String(customScriptOut.text) };
    }
  }

  return {
    text: result.text,
    model_used: result.model_used,
    provider: result.provider,
    system_prompt_rendered: systemPrompt.slice(0, 500),
    mcp_tools_available: mcpEntries.length,
    mcp_tool_calls: result.toolCallLog || [],
    custom_script_ran: customScriptRan,
    custom_script_output: customScriptOut,
  };
  } catch (brainErr) {
    if (scriptMode === 'fallback' && scriptId) {
      const scriptOut = await runCustomScriptHook(null, 'fallback');
      const text = scriptOut.text != null ? String(scriptOut.text) : JSON.stringify(scriptOut);
      return {
        text,
        model_used: 'custom_script',
        provider: 'custom_script',
        system_prompt_rendered: systemPrompt?.slice(0, 500) || '',
        mcp_tools_available: mcpEntries.length,
        mcp_tool_calls: [],
        custom_script_ran: true,
        custom_script_output: scriptOut,
        brain_error: brainErr.message,
      };
    }
    throw brainErr;
  }
}
