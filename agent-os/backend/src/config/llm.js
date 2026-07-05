/**
 * Central LLM config: primary and secondary OpenAPI-compliant endpoints (base URL + API key + model).
 * Each provider uses the same OpenAI SDK shape (e.g. OpenAI, Ollama, DeepSeek). Secondary is tried if primary fails.
 * Use for COO, intent classification, summarize-url (all chat/completions).
 */

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const u = url.trim().replace(/\/$/, '');
  if (u.endsWith('/chat/completions')) return u.replace(/\/chat\/completions$/, '');
  return u;
}

/** True if base URL is local Ollama (no API key required). */
function isLocalOllama(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  try {
    const u = new URL(baseUrl);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch (_) {
    return false;
  }
}

/**
 * @returns {{
 *   primary: { baseUrl: string, apiKey: string, model: string },
 *   secondary: { baseUrl: string, apiKey: string, model: string } | null
 * }}
 */
export function getLlmConfig() {
  const defaultBase = 'https://api.openai.com/v1';
  const primaryBase = normalizeBaseUrl(process.env.OPENAI_PRIMARY_BASE_URL || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_URL || defaultBase) || defaultBase;
  let primaryKey = (process.env.OPENAI_PRIMARY_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const primaryModel = (process.env.OPENAI_PRIMARY_MODEL || process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';

  // Ollama (localhost) does not require a real API key; use placeholder so request is sent
  if (!primaryKey && isLocalOllama(primaryBase)) primaryKey = 'ollama';

  const secondaryBase = normalizeBaseUrl(process.env.OPENAI_SECONDARY_BASE_URL || '');
  let secondaryKey = (process.env.OPENAI_SECONDARY_API_KEY || '').trim();
  const secondaryModel = (process.env.OPENAI_SECONDARY_MODEL || '').trim();
  if (!secondaryKey && isLocalOllama(secondaryBase)) secondaryKey = 'ollama';

  // Secondary: full provider (url + key + model) or same endpoint as primary with different model only
  let secondary = null;
  if (secondaryModel && (secondaryBase && secondaryKey)) {
    secondary = { baseUrl: secondaryBase, apiKey: secondaryKey, model: secondaryModel };
  } else if (secondaryModel && primaryKey) {
    secondary = { baseUrl: primaryBase, apiKey: primaryKey, model: secondaryModel };
  }

  return {
    primary: {
      baseUrl: primaryBase,
      apiKey: primaryKey,
      model: primaryModel,
    },
    secondary,
  };
}

/**
 * Call OpenAPI-compliant chat/completions with optional model override. Tries primary then secondary endpoint.
 * @param {{ messages: Array<{ role: string, content: string }>, modelOverride?: string, maxTokens?: number }}
 * @returns {Promise<{ content: string, modelUsed: string }>}
 */
export async function chatCompletions({ messages, modelOverride, maxTokens = 1024 }) {
  const cfg = getLlmConfig();
  const endpoints = [
    { ...cfg.primary, model: modelOverride || cfg.primary.model },
    cfg.secondary ? { ...cfg.secondary, model: modelOverride || cfg.secondary.model } : null,
  ].filter(Boolean);

  const primary = endpoints[0];
  if (!primary?.baseUrl) throw new Error('OPENAI_PRIMARY_BASE_URL not set');
  if (!primary?.apiKey && !isLocalOllama(primary.baseUrl)) throw new Error('OPENAI_PRIMARY_API_KEY or OPENAI_API_KEY not set (required for non-local endpoints)');

  let lastErr;
  for (const ep of endpoints) {
    if (!ep.apiKey && !isLocalOllama(ep.baseUrl)) continue;
    const chatUrl = `${ep.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
    try {
      const res = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: ep.model,
          max_tokens: maxTokens,
          messages,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content ?? '';
        return { content: typeof content === 'string' ? content : String(content), modelUsed: ep.model };
      }

      const errText = await res.text();
      let errJson;
      try {
        errJson = JSON.parse(errText);
      } catch (_) {}
      lastErr = new Error(errJson?.error?.message || errText || res.statusText);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastErr || new Error('No model available');
}
