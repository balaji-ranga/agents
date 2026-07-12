/**
 * Content tools API: summarize-url (Phase 1). Image and video endpoints in later phases.
 * Kanban tools: move-status, reassign-to-coo, assign-task, intent-classify-and-delegate.
 * Metadata (content_tools_meta), test, invoke, and OpenClaw tools list.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { getSummarizeUrlConfig, getToolsApiKey, getOpenAiConfig, getImageConfig, getVideoConfig, isGptImageModel, mapGptImageQuality } from '../config/tools.js';
import { chatCompletions } from '../config/llm.js';
import { getDb } from '../db/schema.js';
import * as meta from '../services/content-tools-meta.js';
import { assertCallerMayUseTool } from '../services/openclaw-agent-tools.js';
import { scheduleCeoRequestViaOpenClawCron } from '../services/delegation-queue.js';
import {
  listChatTriggerableWorkflows,
  listPublishedWorkflows,
  triggerAgentWorkflowForOwner,
  resolveWorkflowOwnerUserId,
  enquireWorkflows,
} from '../services/agent-workflow-chat-tools.js';
import { applyWorkflowBuilderActions, getWorkflowDraftForAgent } from '../services/agent-workflow-builder.js';
import { resolveAuthenticatedCeoUserId, attachAuthUser, requireAuth, requireCeoOrAdmin } from '../middleware/auth.js';
import { requireToolsAccess, attachToolsAuth } from '../middleware/tools-auth.js';
import { getPublicBaseUrl } from '../config/public-url.js';
import { getOpenClawMediaDir } from '../config/openclaw-paths.js';
import { resolveToolOwnerUserId, resolveToolOwnerUserIdOrNull, bodyWithoutSpoofedOwner } from '../services/tool-owner-scope.js';
import jobApplicantTools from './job-applicant-tools.js';

const router = Router();
const KANBAN_STATUSES = ['open', 'awaiting_confirmation', 'in_progress', 'completed', 'failed'];

function getCallerAgent(req) {
  const id = (
    req.headers['x-openclaw-agent-id'] ||
    req.headers['x-agent-id'] ||
    req.body?.caller_agent_id ||
    req.body?.x_openclaw_agent_id ||
    ''
  )
    .toString()
    .trim();
  if (!id) return null;
  const db = getDb();
  return db.prepare('SELECT id, name, is_coo FROM agents WHERE LOWER(id) = LOWER(?) OR LOWER(openclaw_agent_id) = LOWER(?)').get(id, id) || null;
}

function getCooAgentId() {
  const row = getDb().prepare('SELECT id FROM agents WHERE is_coo = 1 LIMIT 1').get();
  return row ? row.id : null;
}

function isWorkflowBuilderCaller(caller) {
  if (!caller) return false;
  const id = String(caller.id || '').toLowerCase();
  return id === 'workflowbuilder';
}
function getBackendBaseUrl() {
  const override = process.env.TOOLS_BASE_URL || process.env.AGENT_OS_PUBLIC_URL;
  if (override) return String(override).replace(/\/$/, '');
  return getPublicBaseUrl();
}

function logContentTool(toolName, requestPayload, responsePayload, status, source = null, ownerUserId = null) {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO content_tool_logs (tool_name, source, request_payload, response_payload, status, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      toolName,
      source || null,
      typeof requestPayload === 'string' ? requestPayload : JSON.stringify(requestPayload || {}),
      typeof responsePayload === 'string' ? responsePayload : JSON.stringify(responsePayload || {}),
      status,
      ownerUserId || null
    );
  } catch (_) {}
}

function ownerForToolLog(req, body = {}) {
  return resolveToolOwnerUserIdOrNull(req, body, resolveAuthenticatedCeoUserId);
}

function logTool(req, toolName, requestPayload, responsePayload, status, source = null) {
  logContentTool(toolName, requestPayload, responsePayload, status, source, ownerForToolLog(req, requestPayload));
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function extractTitle(html) {
  const match = html && typeof html === 'string' ? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) : null;
  return match ? stripHtml(match[1]).slice(0, 300) : '';
}

function optionalAuth(req, res, next) {
  return requireToolsAccess(req, res, next);
}

function resolveWorkflowOwner(req, body = {}) {
  return resolveWorkflowOwnerUserId(req, bodyWithoutSpoofedOwner(body), resolveAuthenticatedCeoUserId);
}

/**
 * GET /meta — list content tools metadata (authenticated CEO/admin).
 */
router.get('/meta', attachToolsAuth, requireAuth, requireCeoOrAdmin, (req, res) => {
  try {
    const list = meta.listToolsMeta();
    res.json({ tools: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /meta/:name — update tool metadata.
 */
router.patch('/meta/:name', attachToolsAuth, requireAuth, requireCeoOrAdmin, (req, res) => {
  try {
    const name = req.params.name?.trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const row = meta.getToolMeta(name);
    if (!row) return res.status(404).json({ error: 'Tool not found' });
    const updated = meta.updateToolMeta(name, req.body || {});
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /meta — onboard new tool.
 */
router.post('/meta', attachToolsAuth, requireAuth, requireCeoOrAdmin, (req, res) => {
  try {
    const record = meta.createToolMeta(req.body || {});
    res.status(201).json(record);
  } catch (e) {
    if (e.message.includes('required')) return res.status(400).json({ error: e.message });
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Tool name already exists' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /test/:name — test a tool with given body.
 */
router.post('/test/:name', attachToolsAuth, requireAuth, requireCeoOrAdmin, async (req, res) => {
  try {
    const name = req.params.name?.trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const row = meta.getToolMeta(name);
    if (!row) return res.status(404).json({ error: 'Tool not found' });
    if (!row.enabled) return res.status(403).json({ error: 'Tool is disabled' });
    const body = req.body || {};
    const baseUrl = getBackendBaseUrl();
    let targetUrl = row.endpoint;
    if (targetUrl.startsWith('/')) targetUrl = baseUrl + targetUrl;
    const method = String(row.method || 'POST').toUpperCase();
    const headers = { 'Content-Type': 'application/json' };
    if (targetUrl.startsWith(baseUrl)) headers['x-internal-test'] = '1';

    const fetchOpts = {
      method,
      headers,
      signal: AbortSignal.timeout(60000),
    };
    if (method === 'GET' || method === 'HEAD') {
      if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length) {
        const u = new URL(targetUrl);
        for (const [k, v] of Object.entries(body)) {
          if (v == null) continue;
          u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        targetUrl = u.toString();
      }
    } else {
      fetchOpts.body = JSON.stringify(body);
    }

    const response = await fetch(targetUrl, fetchOpts);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.name === 'AbortError' ? 'Request timeout' : e.message });
  }
});

/**
 * GET /logs — scoped to signed-in CEO (admin must impersonate).
 */
router.get('/logs', attachAuthUser, requireAuth, (req, res) => {
  try {
    if (req.authUser.role === 'admin' && !req.authUser.impersonation) {
      return res.json({ logs: [], total: 0 });
    }
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.query || {});
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const tool = typeof req.query.tool === 'string' ? req.query.tool.trim() : null;
    const db = getDb();
    let rows;
    let total;
    if (tool) {
      total = db
        .prepare('SELECT COUNT(*) AS n FROM content_tool_logs WHERE owner_user_id = ? AND tool_name = ?')
        .get(ownerUserId, tool).n;
      rows = db
        .prepare(
          'SELECT id, tool_name, source, request_payload, response_payload, status, owner_user_id, created_at FROM content_tool_logs WHERE owner_user_id = ? AND tool_name = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
        )
        .all(ownerUserId, tool, limit, offset);
    } else {
      total = db.prepare('SELECT COUNT(*) AS n FROM content_tool_logs WHERE owner_user_id = ?').get(ownerUserId).n;
      rows = db
        .prepare(
          'SELECT id, tool_name, source, request_payload, response_payload, status, owner_user_id, created_at FROM content_tool_logs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
        )
        .all(ownerUserId, limit, offset);
    }
    res.json({ logs: rows, total, owner_user_id: ownerUserId });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * DELETE /logs — cleanup content_tool_logs for signed-in CEO only.
 */
router.delete('/logs', attachAuthUser, requireAuth, (req, res) => {
  try {
    if (req.authUser.role === 'admin' && !req.authUser.impersonation) {
      return res.status(403).json({ error: 'Admin must impersonate a user to manage tool logs' });
    }
    const ownerUserId = resolveAuthenticatedCeoUserId(req, req.query || {});
    const db = getDb();
    const all = req.query.all === '1' || req.query.all === 'true';
    let deleted = 0;
    if (all) {
      const result = db.prepare('DELETE FROM content_tool_logs WHERE owner_user_id = ?').run(ownerUserId);
      deleted = result.changes;
    } else {
      const days = Math.max(0, parseInt(req.query.older_than_days, 10) || 7);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const result = db
        .prepare('DELETE FROM content_tool_logs WHERE owner_user_id = ? AND created_at < ?')
        .run(ownerUserId, cutoff);
      deleted = result.changes;
    }
    res.json({ deleted, owner_user_id: ownerUserId });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.use(optionalAuth);

router.use(jobApplicantTools);

/**
 * POST /summarize-url
 * Body: { url: string }
 * Returns: { summary: string, title?: string } or { error: string }
 */
router.post('/summarize-url', async (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = { url: req.body?.url };
  try {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!url) {
      logTool(req,'summarize_url', requestPayload, { error: 'url is required' }, 'error', source);
      return res.status(400).json({ error: 'url is required' });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      logTool(req,'summarize_url', requestPayload, { error: 'Invalid URL' }, 'error', source);
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (parsed.protocol !== 'https:') {
      logTool(req,'summarize_url', requestPayload, { error: 'Only HTTPS URLs are allowed' }, 'error', source);
      return res.status(400).json({ error: 'Only HTTPS URLs are allowed' });
    }

    const { timeoutMs, maxBytes, allowedDomains } = getSummarizeUrlConfig();
    if (allowedDomains && allowedDomains.length > 0) {
      const host = parsed.hostname.toLowerCase();
      if (!allowedDomains.some((d) => host === d || host.endsWith('.' + d))) {
        logTool(req,'summarize_url', requestPayload, { error: 'URL domain not allowed' }, 'error', source);
        return res.status(400).json({ error: 'URL domain not allowed' });
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let body = '';
    let contentLength = 0;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'AgentOS-ContentTools/1.0' },
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        logTool(req,'summarize_url', requestPayload, { error: `Upstream returned ${response.status}` }, 'error', source);
        return res.status(502).json({ error: `Upstream returned ${response.status}` });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        contentLength += value.length;
        if (contentLength > maxBytes) break;
        body += decoder.decode(value, { stream: true });
      }
      if (contentLength > maxBytes) {
        body = body.slice(0, maxBytes);
      }
    } catch (e) {
      clearTimeout(timeoutId);
      const errMsg = e.name === 'AbortError' ? 'Request timeout' : 'Failed to fetch URL';
      logTool(req,'summarize_url', requestPayload, { error: errMsg }, 'error', source);
      if (e.name === 'AbortError') {
        return res.status(504).json({ error: 'Request timeout' });
      }
      return res.status(502).json({ error: 'Failed to fetch URL' });
    }

    const title = extractTitle(body);
    const rawText = stripHtml(body).slice(0, 50000);

    const openai = getOpenAiConfig();
    if (openai.apiKey && rawText.length > 100) {
      try {
        const { content: summaryText } = await chatCompletions({
          messages: [
            {
              role: 'user',
              content: `Summarize the following web page content in 2-4 concise sentences. Preserve key facts and links to the topic.\n\n${rawText.slice(0, 12000)}`,
            },
          ],
          modelOverride: openai.summaryModel || undefined,
          maxTokens: 300,
        });
        const summary = (summaryText && summaryText.trim()) || rawText.slice(0, 500);
        const out = { summary, title: title || undefined };
        logTool(req,'summarize_url', requestPayload, out, 'ok', source);
        return res.json(out);
      } catch (_) {
        // fall through to raw extract
      }
    }

    const summary = rawText.slice(0, 1500).trim() || 'No text content could be extracted.';
    const out = { summary, title: title || undefined };
    logTool(req,'summarize_url', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    logTool(req,'summarize_url', requestPayload, { error: 'Internal error' }, 'error', source);
    res.status(500).json({ error: 'Internal error' });
  }
});

const GENERATED_MEDIA_DIR = getOpenClawMediaDir('generated');

function resolveImagePrompt(body) {
  const candidates = [body?.prompt, body?.description, body?.text, body?.image_prompt];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function buildImageApiBody(img, prompt) {
  const body = { model: img.model, prompt, n: 1, size: img.size };
  if (isGptImageModel(img.model)) {
    body.quality = mapGptImageQuality(img.quality);
    return body;
  }
  if (img.model === 'dall-e-3') {
    body.quality = img.quality;
    body.style = img.style;
    body.response_format = 'url';
    return body;
  }
  if (img.model === 'dall-e-2') {
    body.response_format = 'url';
    return body;
  }
  body.response_format = 'url';
  return body;
}

function persistGeneratedImage(b64Json, format = 'png') {
  const ext = String(format || 'png').toLowerCase().replace(/^\./, '') || 'png';
  mkdirSync(GENERATED_MEDIA_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  writeFileSync(join(GENERATED_MEDIA_DIR, filename), Buffer.from(b64Json, 'base64'));
  return `/api/media/openclaw/generated/${filename}`;
}

function imageResultFromApi(data) {
  const item = data?.data?.[0];
  if (!item) return { error: 'No image in response' };
  if (item.url) return { url: item.url };
  if (item.b64_json) {
    const format = data?.output_format || 'png';
    return { url: persistGeneratedImage(item.b64_json, format) };
  }
  return { error: 'No image URL in response' };
}

/**
 * Phase 2: POST /generate-image — OpenAI-compatible (GPT-image / DALL·E). Primary then secondary endpoint/key/model.
 * Body: { prompt, style_hint? }. Returns: { url } or { error }.
 */
router.post('/generate-image', optionalAuth, async (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-request-source'] || null;
  const prompt = resolveImagePrompt(req.body);
  const styleHint = typeof req.body?.style_hint === 'string' ? req.body.style_hint.trim() : '';
  const requestPayload = { prompt, style_hint: styleHint || undefined };
  try {
    if (!prompt) {
      logTool(req,'generate_image', requestPayload, { error: 'prompt is required' }, 'error', source);
      return res.status(400).json({ error: 'prompt is required' });
    }
    const { primary, secondary } = getImageConfig();
    const endpoints = [primary, secondary].filter((ep) => ep && ep.apiKey);
    if (endpoints.length === 0) {
      logTool(req,'generate_image', requestPayload, { error: 'Image generation not configured (OPENAI_API_KEY or primary/secondary)' }, 'error', source);
      return res.status(503).json({ error: 'Image generation not configured. Set OPENAI_API_KEY or OPENAI_PRIMARY_API_KEY (and optionally OPENAI_SECONDARY_*).' });
    }
    let fullPrompt = prompt;
    if (styleHint) fullPrompt = `${prompt}. Style: ${styleHint}`;
    let lastErr;
    for (const img of endpoints) {
      const cappedPrompt = fullPrompt.slice(0, img.maxPromptChars);
      const body = buildImageApiBody(img, cappedPrompt);
      try {
        const imgRes = await fetch(`${img.apiUrl.replace(/\/$/, '')}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${img.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        const data = await imgRes.json().catch(() => ({}));
        if (!imgRes.ok) {
          lastErr = data?.error?.message || data?.error || imgRes.statusText;
          continue;
        }
        const result = imageResultFromApi(data);
        if (result.error) {
          lastErr = result.error;
          continue;
        }
        const out = { url: result.url };
        logTool(req,'generate_image', requestPayload, out, 'ok', source);
        return res.json(out);
      } catch (e) {
        lastErr = e.name === 'AbortError' ? 'Request timeout' : (e.message || 'Internal error');
      }
    }
    logTool(req,'generate_image', requestPayload, { error: lastErr }, 'error', source);
    return res.status(502).json({ error: lastErr || 'Image API error' });
  } catch (e) {
    const errMsg = e.name === 'AbortError' ? 'Request timeout' : (e.message || 'Internal error');
    logTool(req,'generate_image', requestPayload, { error: errMsg }, 'error', source);
    return res.status(500).json({ error: errMsg });
  }
});

/**
 * Phase 3: POST /generate-video — Replicate (async). Primary then secondary endpoint/token/model.
 * Body: { prompt, duration_sec? }. Returns: { job_id, status, url? } or { error }.
 */
router.post('/generate-video', optionalAuth, async (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-request-source'] || null;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const requestPayload = req.body || {};
  try {
    if (!prompt) {
      logTool(req,'generate_video', requestPayload, { error: 'prompt is required' }, 'error', source);
      return res.status(400).json({ error: 'prompt is required' });
    }
    const { primary, secondary } = getVideoConfig();
    const endpoints = [primary, secondary].filter((ep) => ep && ep.apiToken && ep.modelVersion);
    if (endpoints.length === 0) {
      logTool(req,'generate_video', requestPayload, { error: 'Video generation not configured (REPLICATE_API_TOKEN or primary/secondary)' }, 'error', source);
      return res.status(503).json({ error: 'Video generation not configured. Set REPLICATE_API_TOKEN (and optionally REPLICATE_SECONDARY_*).' });
    }
    let lastErr;
    for (const vid of endpoints) {
      const cappedPrompt = prompt.slice(0, vid.maxPromptChars);
      try {
        const createRes = await fetch(`${vid.apiUrl.replace(/\/$/, '')}/predictions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${vid.apiToken}`,
          },
          body: JSON.stringify({
            version: vid.modelVersion,
            input: { prompt: cappedPrompt },
          }),
          signal: AbortSignal.timeout(15000),
        });
        const pred = await createRes.json().catch(() => ({}));
        if (!createRes.ok) {
          lastErr = pred?.detail || pred?.error || createRes.statusText || 'Replicate API error';
          continue;
        }
        const jobId = pred.id;
        const status = pred.status || 'starting';
        let url = null;
        if (pred.output && (Array.isArray(pred.output) ? pred.output[0] : pred.output)) {
          const outVal = Array.isArray(pred.output) ? pred.output[0] : pred.output;
          url = typeof outVal === 'string' ? outVal : outVal?.url || null;
        }
        const out = { job_id: jobId, status, url: url || undefined };
        logTool(req,'generate_video', requestPayload, out, 'ok', source);
        return res.json(out);
      } catch (e) {
        lastErr = e.name === 'AbortError' ? 'Request timeout' : (e.message || 'Internal error');
      }
    }
    logTool(req,'generate_video', requestPayload, { error: lastErr }, 'error', source);
    return res.status(502).json({ error: lastErr || 'Replicate API error' });
  } catch (e) {
    const errMsg = e.name === 'AbortError' ? 'Request timeout' : (e.message || 'Internal error');
    logTool(req,'generate_video', requestPayload, { error: errMsg }, 'error', source);
    return res.status(500).json({ error: errMsg });
  }
});

/**
 * Kanban tool: move task status. Any agent can move status of a task they are assigned to; COO can move any task.
 * Logged to content_tool_logs.
 */
router.post('/kanban-move-status', optionalAuth, (req, res) => {
  let source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  const taskId = Number(requestPayload.task_id);
  const newStatus = (requestPayload.new_status || requestPayload.status || '').toString().trim();
  try {
    if (!taskId || !KANBAN_STATUSES.includes(newStatus)) {
      const err = { error: 'task_id and new_status required; new_status one of: ' + KANBAN_STATUSES.join(', ') };
      logTool(req,'kanban_move_status', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const db = getDb();
    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(taskId);
    if (!task) {
      const err = { error: 'Task not found' };
      logTool(req,'kanban_move_status', requestPayload, err, 'error', source);
      return res.status(404).json(err);
    }
    let caller = getCallerAgent(req);
    // When invoked from gateway plugin without agent id: allow move if request is internal (from our /invoke) and task has assigned agent
    if (!caller && task.assigned_agent_id && req.headers['x-internal-test'] === '1') {
      caller = db.prepare('SELECT id, name, is_coo FROM agents WHERE LOWER(id) = LOWER(?) OR LOWER(openclaw_agent_id) = LOWER(?)').get(task.assigned_agent_id, task.assigned_agent_id) || null;
      if (caller) source = caller.id;
    }
    const cooId = getCooAgentId();
    const isCoo = caller && caller.is_coo;
    const isAssigned = task.assigned_agent_id && caller && (task.assigned_agent_id === caller.id || task.assigned_agent_id === caller.name);
    if (!isCoo && !isAssigned) {
      const err = { error: 'Only COO or the assigned agent can move this task status' };
      logTool(req,'kanban_move_status', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    db.prepare("UPDATE kanban_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, taskId);
    const out = { ok: true, task_id: taskId, status: newStatus };
    logTool(req,'kanban_move_status', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'kanban_move_status', requestPayload, err, 'error', source);
    res.status(500).json(err);
  }
});

/**
 * Kanban tool: reassign task to COO. Only non-COO agents (assigned agent can hand back to COO).
 */
router.post('/kanban-reassign-to-coo', optionalAuth, (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  const taskId = Number(requestPayload.task_id);
  try {
    if (!taskId) {
      const err = { error: 'task_id required' };
      logTool(req,'kanban_reassign_to_coo', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const caller = getCallerAgent(req);
    if (caller && caller.is_coo) {
      const err = { error: 'COO cannot use reassign-to-coo; use assign-task to assign to another agent' };
      logTool(req,'kanban_reassign_to_coo', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const cooId = getCooAgentId();
    if (!cooId) {
      const err = { error: 'No COO agent in system' };
      logTool(req,'kanban_reassign_to_coo', requestPayload, err, 'error', source);
      return res.status(502).json(err);
    }
    const db = getDb();
    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(taskId);
    if (!task) {
      const err = { error: 'Task not found' };
      logTool(req,'kanban_reassign_to_coo', requestPayload, err, 'error', source);
      return res.status(404).json(err);
    }
    db.prepare("UPDATE kanban_tasks SET assigned_agent_id = ?, status = 'open', updated_at = datetime('now') WHERE id = ?").run(cooId, taskId);
    const out = { ok: true, task_id: taskId, assigned_agent_id: cooId };
    logTool(req,'kanban_reassign_to_coo', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'kanban_reassign_to_coo', requestPayload, err, 'error', source);
    res.status(500).json(err);
  }
});

/**
 * Kanban tool: assign task to an agent. Only COO can assign to another agent.
 */
router.post('/kanban-assign-task', optionalAuth, (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  const taskId = Number(requestPayload.task_id);
  const toAgentId = (requestPayload.to_agent_id || requestPayload.agent_id || '').toString().trim().toLowerCase();
  try {
    if (!taskId || !toAgentId) {
      const err = { error: 'task_id and to_agent_id required' };
      logTool(req,'kanban_assign_task', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const caller = getCallerAgent(req);
    if (!caller || !caller.is_coo) {
      const err = { error: 'Only COO can assign a task to another agent' };
      logTool(req,'kanban_assign_task', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const db = getDb();
    const agent = db.prepare('SELECT id FROM agents WHERE LOWER(id) = ? OR LOWER(openclaw_agent_id) = ?').get(toAgentId, toAgentId);
    if (!agent) {
      const err = { error: 'Agent not found' };
      logTool(req,'kanban_assign_task', requestPayload, err, 'error', source);
      return res.status(404).json(err);
    }
    const task = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(taskId);
    if (!task) {
      const err = { error: 'Task not found' };
      logTool(req,'kanban_assign_task', requestPayload, err, 'error', source);
      return res.status(404).json(err);
    }
    db.prepare("UPDATE kanban_tasks SET assigned_agent_id = ?, status = 'awaiting_confirmation', updated_at = datetime('now') WHERE id = ?").run(agent.id, taskId);
    const out = { ok: true, task_id: taskId, assigned_agent_id: agent.id };
    logTool(req,'kanban_assign_task', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'kanban_assign_task', requestPayload, err, 'error', source);
    res.status(500).json(err);
  }
});

/**
 * Intent classify and delegate: COO only. Runs intent classification and creates delegation + kanban tasks.
 * Body: message (required), standup_id (optional; if omitted, creates a new standup).
 */
router.post('/intent-classify-and-delegate', optionalAuth, async (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  const message = (requestPayload.message || requestPayload.prompt || '').toString().trim();
  let standupId = requestPayload.standup_id != null ? Number(requestPayload.standup_id) : null;
  try {
    if (!message) {
      const err = { error: 'message required' };
      logTool(req,'intent_classify_and_delegate', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const caller = getCallerAgent(req);
    if (!caller || !caller.is_coo) {
      const err = { error: 'Only COO can use intent-classify-and-delegate' };
      logTool(req,'intent_classify_and_delegate', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const db = getDb();
    if (standupId == null) {
      db.prepare('INSERT INTO standups (scheduled_at, status, source) VALUES (datetime("now"), ?, ?)').run('scheduled', 'kanban');
      standupId = db.prepare('SELECT id FROM standups ORDER BY id DESC LIMIT 1').get().id;
    } else {
      const standup = db.prepare('SELECT id FROM standups WHERE id = ?').get(standupId);
      if (!standup) {
        const err = { error: 'Standup not found' };
        logTool(req,'intent_classify_and_delegate', requestPayload, err, 'error', source);
        return res.status(404).json(err);
      }
    }
    const result = await scheduleCeoRequestViaOpenClawCron(standupId, message);
    const out = {
      ok: true,
      request_id: result.requestId,
      count: result.count,
      agent_names: result.agentNames,
      kanban_task_ids: result.kanbanTaskIds || [],
    };
    logTool(req,'intent_classify_and_delegate', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'intent_classify_and_delegate', requestPayload, err, 'error', source);
    res.status(500).json(err);
  }
});

/**
 * Enquire about workflows by description or natural-language query (COO only).
 */
router.post('/agent-workflow-enquire', optionalAuth, (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  try {
    const caller = getCallerAgent(req);
    if (!caller || !caller.is_coo) {
      const err = { error: 'Only COO can enquire about agent workflows' };
      logTool(req,'agent_workflow_enquire', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const query =
      requestPayload.query ||
      requestPayload.description ||
      requestPayload.message ||
      requestPayload.q ||
      '';
    if (!String(query).trim() && !requestPayload.all) {
      const err = { error: 'query or description required (or pass all: true to list every published workflow)' };
      logTool(req,'agent_workflow_enquire', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const ownerUserId = resolveWorkflowOwner(req, requestPayload);
    const out = {
      ok: true,
      ceo_user_id: ownerUserId,
      ...enquireWorkflows(ownerUserId, query, {
        limit: requestPayload.limit,
        all: requestPayload.all === true,
      }),
    };
    logTool(req,'agent_workflow_enquire', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'agent_workflow_enquire', requestPayload, err, 'error', source);
    res.status(e.status || 500).json(err);
  }
});

/**
 * List published agent workflows (COO only). Default: all published; pass chat_only: true for chat-phrase triggers only.
 */
router.post('/agent-workflow-list', optionalAuth, (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  try {
    const caller = getCallerAgent(req);
    if (!caller || !caller.is_coo) {
      const err = { error: 'Only COO can list agent workflows' };
      logTool(req,'agent_workflow_list', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const ownerUserId = resolveWorkflowOwner(req, requestPayload);
    const chatOnly = requestPayload.chat_only === true || requestPayload.chatOnly === true;
    const workflows = listPublishedWorkflows(ownerUserId, { chatOnly });
    const out = {
      ok: true,
      ceo_user_id: ownerUserId,
      chat_only: chatOnly,
      workflows,
      count: workflows.length,
    };
    logTool(req,'agent_workflow_list', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'agent_workflow_list', requestPayload, err, 'error', source);
    res.status(500).json(err);
  }
});

/**
 * Trigger a published agent workflow by chat phrase or workflow_id (COO only).
 */
router.post('/agent-workflow-trigger', optionalAuth, async (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  try {
    const caller = getCallerAgent(req);
    if (!caller || !caller.is_coo) {
      const err = { error: 'Only COO can trigger agent workflows' };
      logTool(req,'agent_workflow_trigger', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const message = (requestPayload.message || requestPayload.input || '').toString().trim();
    const workflowId = requestPayload.workflow_id || requestPayload.workflowId || null;
    if (!message && !workflowId) {
      const err = { error: 'message or workflow_id required' };
      logTool(req,'agent_workflow_trigger', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const ownerUserId = resolveWorkflowOwner(req, requestPayload);
    const run = await triggerAgentWorkflowForOwner(ownerUserId, {
      message,
      workflow_id: workflowId,
      input: message,
      actor: { id: caller.id, name: caller.name, type: 'coo' },
    });
    const out = {
      ok: true,
      run_id: run.id,
      run_number: run.run_number,
      definition_id: run.definition_id,
      definition_name: run.definition_name,
      status: run.status,
      ceo_user_id: ownerUserId,
    };
    logTool(req,'agent_workflow_trigger', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'agent_workflow_trigger', requestPayload, err, 'error', source);
    res.status(400).json(err);
  }
});

/**
 * Get workflow draft graph (Workflow Builder agent only).
 */
router.post('/agent-workflow-get-draft', optionalAuth, (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  try {
    const caller = getCallerAgent(req);
    if (!isWorkflowBuilderCaller(caller)) {
      const err = { error: 'Only Workflow Builder agent can get workflow drafts via this tool' };
      logTool(req,'agent_workflow_get_draft', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const workflowId = requestPayload.workflow_id || requestPayload.workflowId;
    if (!workflowId) {
      const err = { error: 'workflow_id required' };
      logTool(req,'agent_workflow_get_draft', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const ownerUserId = resolveWorkflowOwner(req, requestPayload);
    const out = { ok: true, ...getWorkflowDraftForAgent(ownerUserId, workflowId) };
    logTool(req,'agent_workflow_get_draft', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'agent_workflow_get_draft', requestPayload, err, 'error', source);
    res.status(400).json(err);
  }
});

/**
 * Mutate workflow draft (Workflow Builder agent only).
 */
router.post('/agent-workflow-mutate', optionalAuth, async (req, res) => {
  const source = req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || null;
  const requestPayload = req.body || {};
  try {
    const caller = getCallerAgent(req);
    if (!isWorkflowBuilderCaller(caller)) {
      const err = { error: 'Only Workflow Builder agent can mutate workflows via this tool' };
      logTool(req,'agent_workflow_mutate', requestPayload, err, 'error', source);
      return res.status(403).json(err);
    }
    const actions = requestPayload.actions;
    if (!Array.isArray(actions) || !actions.length) {
      const err = { error: 'actions array required' };
      logTool(req,'agent_workflow_mutate', requestPayload, err, 'error', source);
      return res.status(400).json(err);
    }
    const ownerUserId = resolveWorkflowOwner(req, requestPayload);
    const result = await applyWorkflowBuilderActions(
      ownerUserId,
      requestPayload.workflow_id || requestPayload.workflowId || null,
      actions,
      { id: caller.id, name: caller.name, type: 'workflow_builder' }
    );
    const out = { ok: true, ...result };
    logTool(req,'agent_workflow_mutate', requestPayload, out, 'ok', source);
    res.json(out);
  } catch (e) {
    const err = { error: e.message };
    logTool(req,'agent_workflow_mutate', requestPayload, err, 'error', source);
    res.status(400).json(err);
  }
});

/**
 * POST /invoke — invoke a tool by name (used by OpenClaw plugin). Body: { tool_name, caller_agent_id?, ...params }.
 * Uses x-openclaw-agent-id header or body.caller_agent_id so Kanban tools can authorize the calling agent.
 */
router.post('/invoke', requireToolsAccess, async (req, res) => {
  let source = (req.headers['x-openclaw-agent-id'] || req.headers['x-agent-id'] || '').toString().trim() || null;
  if (!source && req.body && (req.body.caller_agent_id != null || req.body.x_openclaw_agent_id != null)) {
    source = String(req.body.caller_agent_id ?? req.body.x_openclaw_agent_id).trim() || null;
  }
  try {
    const toolName = (req.body?.tool_name || req.body?.toolName || '').trim();
    if (!toolName) return res.status(400).json({ error: 'tool_name required' });
    const row = meta.getToolMeta(toolName);
    if (!row) return res.status(404).json({ error: 'Tool not found' });
    if (!row.enabled) {
      logTool(req,toolName, req.body, { error: 'Tool is disabled' }, 'error', source);
      return res.status(403).json({ error: 'Tool is disabled' });
    }
    const grantCheck = assertCallerMayUseTool(source, toolName);
    if (!grantCheck.ok) {
      logTool(req,toolName, req.body, { error: grantCheck.error }, 'error', source);
      return res.status(403).json({ error: grantCheck.error });
    }
    const params = { ...req.body };
    delete params.tool_name;
    delete params.toolName;
    delete params.caller_agent_id;
    delete params.x_openclaw_agent_id;
    const baseUrl = getBackendBaseUrl();
    let targetUrl = row.endpoint;
    if (targetUrl.startsWith('/')) targetUrl = baseUrl + targetUrl;
    const method = (row.method || 'POST').toUpperCase();
    // Default base=USD for Frankfurter API when agent omits it
    if (method === 'GET' && targetUrl.includes('frankfurter') && (params.base == null || params.base === '')) {
      params.base = 'USD';
    }
    const headers = { 'Content-Type': 'application/json' };
    if (source) headers['x-openclaw-agent-id'] = source;
    for (const h of ['x-ceo-user-id', 'x-agent-os-user-id', 'x-openclaw-session-key', 'x-openclaw-session-user', 'x-session-key']) {
      if (req.headers[h]) headers[h] = String(req.headers[h]);
    }
    const ownerUserId = resolveToolOwnerUserIdOrNull(req, params, resolveAuthenticatedCeoUserId);
    if (ownerUserId) {
      if (!params.ceo_user_id && !params.ceoUserId && !params.owner_user_id) {
        params.ceo_user_id = ownerUserId;
      }
      if (!headers['x-ceo-user-id']) headers['x-ceo-user-id'] = ownerUserId;
    }
    if (row.auth_header && typeof row.auth_header === 'string' && row.auth_header.trim()) {
      headers['Authorization'] = row.auth_header.trim();
    }
    if (targetUrl.startsWith(baseUrl)) headers['x-internal-test'] = '1';
    const fetchOpts = { method, headers, signal: AbortSignal.timeout(90000) };
    if (method === 'GET') {
      const url = new URL(targetUrl);
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
      targetUrl = url.toString();
    } else {
      fetchOpts.body = JSON.stringify(params);
    }
    const response = await fetch(targetUrl, fetchOpts);
    const data = await response.json().catch(() => ({}));
    const status = response.ok ? 'ok' : 'error';
    logTool(req,toolName, params, data, status, source);
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (e) {
    const errMsg = e.name === 'AbortError' ? 'Request timeout' : e.message;
    logTool(req,req.body?.tool_name || '?', req.body, { error: errMsg }, 'error', source);
    res.status(500).json({ error: errMsg });
  }
});

export default router;
