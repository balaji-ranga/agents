/**
 * Open SSE streams and parse random_number / generic JSON events.
 */
import { parseMcpAuth } from './mcp-auth.js';

export function resolveMcpEventsStreamUrl(server, eventsPath = '/events/stream') {
  const base = String(server?.url || '').trim().replace(/\/$/, '');
  if (!base) throw new Error('MCP server URL is required');
  const path = String(eventsPath || '/events/stream').startsWith('/')
    ? eventsPath
    : `/${eventsPath}`;
  if (base.endsWith('/mcp')) return base.replace(/\/mcp$/, path);
  return `${base}${path}`;
}

export function parseSseDataLines(text) {
  const events = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('data: ')) {
      const raw = line.slice(6).trim();
      if (!raw || raw.startsWith(':')) continue;
      try {
        events.push(JSON.parse(raw));
      } catch {
        events.push({ raw });
      }
    }
  }
  return events;
}

/**
 * Wait for the first SSE event on an MCP server's events stream.
 */
export function waitForMcpSseEvent(server, options = {}) {
  const {
    eventsPath = '/events/stream',
    timeoutMs = 30000,
    authSource = null,
    signal: externalSignal = null,
  } = options;

  const url = resolveMcpEventsStreamUrl(server, eventsPath);
  const { headers: authHeaders } = parseMcpAuth(authSource || {});

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`SSE listen timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeout);
        reject(new Error('SSE listen aborted'));
        return;
      }
      externalSignal.addEventListener('abort', () => {
        controller.abort();
        clearTimeout(timeout);
        reject(new Error('SSE listen aborted'));
      });
    }

    fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...authHeaders,
      },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`SSE ${res.status}: ${text.slice(0, 200)}`);
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
            const parsed = parseSseDataLines(chunk);
            for (const event of parsed) {
              if (event?.type === 'random_number' || event?.value != null) {
                clearTimeout(timeout);
                controller.abort();
                const num = Number(event.value);
                const p =
                  event.parity === 'odd' || event.parity === 'even'
                    ? event.parity
                    : Number.isFinite(num)
                      ? num % 2 === 0
                        ? 'even'
                        : 'odd'
                      : 'odd';
                resolve({ event, parity: p, value: Number.isFinite(num) ? num : null });
                return;
              }
            }
          }
        }
        clearTimeout(timeout);
        reject(new Error('SSE stream ended without an event'));
      })
      .catch((err) => {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          reject(new Error('SSE listen aborted'));
          return;
        }
        reject(err);
      });
  });
}
