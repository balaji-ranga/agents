/**
 * Brain node LLM provider presets (OpenAI-compatible, Anthropic, Ollama, OpenRouter).
 */

export const BRAIN_PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    envApiKey: ['OPENAI_API_KEY', 'OPENAI_PRIMARY_API_KEY'],
    envBaseUrl: ['OPENAI_BASE_URL', 'OPENAI_PRIMARY_BASE_URL'],
    envModel: ['OPENAI_DEFAULT_MODEL', 'OPENAI_PRIMARY_MODEL'],
    protocol: 'openai',
    requiresKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    envApiKey: ['ANTHROPIC_API_KEY'],
    envBaseUrl: ['ANTHROPIC_BASE_URL'],
    envModel: ['ANTHROPIC_MODEL'],
    protocol: 'anthropic',
    requiresKey: true,
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
    envApiKey: [],
    envBaseUrl: ['OLLAMA_BASE_URL'],
    envModel: ['OLLAMA_MODEL'],
    protocol: 'openai',
    requiresKey: false,
    placeholderApiKey: 'ollama',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    envApiKey: ['OPENROUTER_API_KEY'],
    envBaseUrl: ['OPENROUTER_BASE_URL'],
    envModel: ['OPENROUTER_MODEL'],
    protocol: 'openai',
    requiresKey: true,
    extraHeadersFromEnv: {
      'HTTP-Referer': 'OPENROUTER_HTTP_REFERER',
      'X-Title': 'OPENROUTER_SITE_TITLE',
    },
  },
};

function firstEnv(keys = []) {
  for (const key of keys) {
    const v = (process.env[key] || '').trim();
    if (v) return v;
  }
  return '';
}

function isLocalOllamaBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function nodeApiKey(cfg = {}) {
  return String(cfg.apiKey || cfg.api_key || '').trim();
}

function buildOpenRouterHeaders(cfg = {}) {
  const extraHeaders = {};
  const referer = String(cfg.httpReferer || '').trim();
  const title = String(cfg.siteTitle || '').trim() || 'Agent OS';
  if (referer) extraHeaders['HTTP-Referer'] = referer;
  if (title) extraHeaders['X-Title'] = title;
  return extraHeaders;
}

/**
 * Workflow Brain — credentials come only from the node's taskConfig (never platform .env).
 */
export function resolveWorkflowBrainProviderConfig(modelSource, cfg = {}) {
  const source = (modelSource || 'openai').toLowerCase();
  const preset = BRAIN_PROVIDERS[source] || BRAIN_PROVIDERS.openai;

  const baseUrl = (cfg.apiEndpoint || '').trim() || preset.baseUrl;
  const configuredKey = nodeApiKey(cfg);
  let apiKey = configuredKey;
  const model = (cfg.model || '').trim() || preset.model;

  if (!apiKey && preset.placeholderApiKey) apiKey = preset.placeholderApiKey;

  const extraHeaders = source === 'openrouter' ? buildOpenRouterHeaders(cfg) : {};

  return {
    source,
    preset,
    baseUrl,
    apiKey,
    configuredKey,
    model,
    protocol: preset.protocol,
    requiresKey: preset.requiresKey,
    extraHeaders,
  };
}

/** Validate Brain nodes have per-node API keys before publish/run (no platform .env fallback). */
export function validateWorkflowBrainCredentials(graph) {
  const errors = [];
  for (const node of graph?.nodes || []) {
    if (node.type !== 'brain') continue;
    const cfg = node.data?.taskConfig || node.data?.config || {};
    const { source, requiresKey, baseUrl, configuredKey } = resolveWorkflowBrainProviderConfig(
      cfg.modelSource,
      cfg
    );
    if (requiresKey && !configuredKey && !isLocalOllamaBaseUrl(baseUrl)) {
      const label = node.data?.label || node.id;
      errors.push(
        `Brain "${label}" (${node.id}): set ${source} API key on the Brain node — platform .env keys are not used for workflows`
      );
    }
  }
  return errors;
}

/** Resolve base URL, API key, model — includes .env fallback (platform services / dev scripts only). */
export function resolveBrainProviderConfig(modelSource, cfg = {}) {
  const source = (modelSource || 'openai').toLowerCase();
  const preset = BRAIN_PROVIDERS[source] || BRAIN_PROVIDERS.openai;

  let baseUrl = (cfg.apiEndpoint || '').trim() || firstEnv(preset.envBaseUrl) || preset.baseUrl;
  let apiKey = nodeApiKey(cfg) || firstEnv(preset.envApiKey);
  let model = (cfg.model || '').trim() || firstEnv(preset.envModel) || preset.model;

  if (!apiKey && preset.placeholderApiKey) apiKey = preset.placeholderApiKey;

  const extraHeaders = {};
  if (preset.extraHeadersFromEnv) {
    for (const [header, envKey] of Object.entries(preset.extraHeadersFromEnv)) {
      const fromCfg = cfg[header === 'HTTP-Referer' ? 'httpReferer' : header === 'X-Title' ? 'siteTitle' : ''] || '';
      const value = String(fromCfg || process.env[envKey] || '').trim();
      if (value) extraHeaders[header] = value;
    }
  }
  if (source === 'openrouter' && !extraHeaders['X-Title']) {
    extraHeaders['X-Title'] = 'Agent OS';
  }

  return {
    source,
    preset,
    baseUrl,
    apiKey,
    model,
    protocol: preset.protocol,
    requiresKey: preset.requiresKey,
    extraHeaders,
  };
}
