/**
 * Persistent generic SSE subscription (not one-off).
 */
import { parseMcpAuth } from './mcp-auth.js';
import { parseSseDataLines, resolveMcpEventsStreamUrl } from './mcp-event-stream.js';

export function resolveSseStreamUrl(config = {}, server = null) {
  const direct = String(config.streamUrl || config.stream_url || '').trim();
  if (direct) return direct;
  if (server?.url) return resolveMcpEventsStreamUrl(server, config.eventsPath || config.events_path || '/events/stream');
  throw new Error('SSE stream URL or MCP server is required');
}

function buildStreamHeaders(authSource = null) {
  const { headers: authHeaders } = parseMcpAuth(authSource || {});
  return {
    Accept: 'text/event-stream',
    ...authHeaders,
  };
}

/**
 * Long-lived SSE subscription — calls onEvent for each JSON payload in data: lines.
 * @returns {() => void} abort
 */
export function subscribeSseStream(url, { authSource = null, signal = null, onEvent, onEnd, onError } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      abort();
      return abort;
    }
    signal.addEventListener('abort', abort);
  }

  fetch(url, {
    method: 'GET',
    headers: buildStreamHeaders(authSource),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`SSE ${res.status}: ${res.statusText || res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.body) throw new Error('SSE response has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const chunk of parts) {
          for (const event of parseSseDataLines(chunk)) {
            if (event && typeof event === 'object') onEvent?.(event);
          }
        }
      }
      onEnd?.();
    })
    .catch((err) => {
      if (err.name === 'AbortError') {
        onEnd?.({ aborted: true });
        return;
      }
      onError?.(err);
    });

  return abort;
}
