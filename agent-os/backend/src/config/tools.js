/**
 * Content-tools backend config. All values from env.
 * LLM (chat) uses config/llm.js with primary/secondary base URL, API key, model.
 * Image and video each have primary + secondary endpoint and key/model (OpenAI SDK–compatible or Replicate).
 */
import { getLlmConfig } from './llm.js';

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/$/, '');
}

export function getSummarizeUrlConfig() {
  const timeoutMs = parseInt(process.env.TOOLS_SUMMARIZE_TIMEOUT_MS || '10000', 10);
  const maxBytes = parseInt(process.env.TOOLS_SUMMARIZE_MAX_BYTES || '512000', 10);
  const allowedDomainsRaw = process.env.TOOLS_SUMMARIZE_ALLOWED_DOMAINS || '';
  const allowedDomains = allowedDomainsRaw
    ? allowedDomainsRaw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
    : null;
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512000,
    allowedDomains,
  };
}

export function getToolsApiKey() {
  return process.env.TOOLS_API_KEY || '';
}

/** Summary model override for summarize-url (otherwise LLM primary/secondary from llm.js). */
export function getOpenAiConfig() {
  const llm = getLlmConfig();
  const summaryModel = (process.env.TOOLS_SUMMARIZE_MODEL || '').trim() || llm.primary.model;
  return {
    summaryModel: summaryModel || undefined,
    primaryModel: llm.primary.model,
    secondaryModel: llm.secondary?.model,
  };
}

/** GPT-image models (gpt-image-1, gpt-image-1-mini, etc.) replace retired DALL·E for new OpenAI keys. */
export function isGptImageModel(model) {
  return /^gpt-image/i.test(String(model || '').trim());
}

/** Map legacy DALL·E quality env values to GPT-image quality. */
export function mapGptImageQuality(quality) {
  const q = String(quality || '').toLowerCase();
  if (q === 'hd' || q === 'high') return 'high';
  if (q === 'low' || q === 'medium' || q === 'auto') return q;
  return 'medium';
}

/**
 * Image generation: primary and secondary providers (each base URL + API key + model). OpenAI SDK–compatible.
 * Default model is gpt-image-1 (DALL·E 2/3 retired for many accounts as of 2026).
 * @returns {{ primary: { apiUrl: string, apiKey: string, model: string, size, quality, style, maxPromptChars }, secondary: object | null }}
 */
export function getImageConfig() {
  const defaultBase = 'https://api.openai.com/v1';
  const primaryBase = normalizeBaseUrl(process.env.OPENAI_PRIMARY_BASE_URL || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_URL || defaultBase) || defaultBase;
  const primaryKey = (process.env.OPENAI_PRIMARY_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const primaryModel = (process.env.TOOLS_IMAGE_MODEL || 'gpt-image-1').trim();
  const size = process.env.TOOLS_IMAGE_SIZE || '1024x1024';
  const quality = process.env.TOOLS_IMAGE_QUALITY || 'standard';
  const style = process.env.TOOLS_IMAGE_STYLE || 'natural';
  const maxPromptChars = Math.min(parseInt(process.env.TOOLS_IMAGE_MAX_PROMPT_CHARS || '1000', 10) || 1000, 4000);

  const secondaryBase = normalizeBaseUrl(process.env.OPENAI_SECONDARY_BASE_URL || '');
  const secondaryKey = (process.env.OPENAI_SECONDARY_API_KEY || '').trim();
  const secondaryModel = (process.env.TOOLS_IMAGE_SECONDARY_MODEL || '').trim();

  const primary = {
    apiUrl: primaryBase,
    apiKey: primaryKey,
    model: primaryModel,
    size: size || '1024x1024',
    quality: quality === 'hd' ? 'hd' : 'standard',
    style: style === 'vivid' ? 'vivid' : 'natural',
    maxPromptChars,
  };

  const secondary = secondaryBase && secondaryKey && secondaryModel
    ? {
        apiUrl: secondaryBase,
        apiKey: secondaryKey,
        model: secondaryModel,
        size: primary.size,
        quality: primary.quality,
        style: primary.style,
        maxPromptChars,
      }
    : null;

  return { primary, secondary };
}

// Zeroscope (free/open model on Replicate; you pay Replicate per run). Or use Google Veo on Replicate: e.g. google/veo-2, google/veo-3, google/veo-3-fast — set TOOLS_VIDEO_MODEL_VERSION from Replicate portal.
const DEFAULT_VIDEO_MODEL_VERSION = 'anotherjesse/zeroscope-v2-xl:8ba52bde11300615f65e9591d7afc58816def12c93c870fa583ff67ae17afdda';
const REPLICATE_DEFAULT_BASE = 'https://api.replicate.com/v1';

/**
 * Video generation: primary and secondary (each base URL + API token + model version). Replicate API.
 * @returns {{ primary: { apiUrl: string, apiToken: string, modelVersion: string, maxPromptChars: number }, secondary: object | null }}
 */
export function getVideoConfig() {
  const maxPromptChars = Math.min(parseInt(process.env.TOOLS_VIDEO_MAX_PROMPT_CHARS || '500', 10) || 500, 2000);

  const primaryBase = normalizeBaseUrl(process.env.REPLICATE_PRIMARY_BASE_URL || process.env.REPLICATE_BASE_URL || REPLICATE_DEFAULT_BASE) || REPLICATE_DEFAULT_BASE;
  const primaryToken = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_PRIMARY_API_TOKEN || '').trim();
  const primaryVersion = (process.env.TOOLS_VIDEO_MODEL_VERSION || '').trim() || DEFAULT_VIDEO_MODEL_VERSION;

  const secondaryBase = normalizeBaseUrl(process.env.REPLICATE_SECONDARY_BASE_URL || '');
  const secondaryToken = (process.env.REPLICATE_SECONDARY_API_TOKEN || '').trim();
  const secondaryVersion = (process.env.TOOLS_VIDEO_SECONDARY_MODEL_VERSION || '').trim();

  const primary = {
    apiUrl: primaryBase,
    apiToken: primaryToken,
    modelVersion: primaryVersion,
    maxPromptChars,
  };

  const secondary = secondaryBase && secondaryToken && secondaryVersion
    ? {
        apiUrl: secondaryBase,
        apiToken: secondaryToken,
        modelVersion: secondaryVersion,
        maxPromptChars,
      }
    : null;

  return { primary, secondary };
}
