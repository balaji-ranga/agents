/**
 * Node completion timeout for Brain, API, MCP, and Custom Script steps.
 * Not a forced wait — the step proceeds as soon as work finishes; this is a max duration.
 */
export const DEFAULT_NODE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

export const NODE_TIMEOUT_CONFIG_FIELDS = [
  {
    id: 'timeoutMs',
    label: 'Node timeout (ms)',
    type: 'number',
    default: DEFAULT_NODE_TIMEOUT_MS,
    description:
      'Maximum time for this step to complete (default 20 minutes). If it finishes sooner, the run continues immediately.',
  },
  {
    id: 'timeoutAction',
    label: 'On timeout',
    type: 'select',
    options: ['fail', 'default_output'],
    default: 'fail',
    description: 'fail = fail the run; default_output = continue with Default output JSON',
  },
  {
    id: 'defaultTimeoutOutput',
    label: 'Default output on timeout (JSON)',
    type: 'textarea',
    placeholder: '{"text":"","ok":false}',
    default: '{}',
    description: 'Used when On timeout = default_output. Merged into the step outputs.',
  },
];

export class NodeTimeoutError extends Error {
  constructor(timeoutMs) {
    const secs = Math.round(Number(timeoutMs) / 1000);
    super(`Node timed out after ${Math.max(1, Math.round(Number(timeoutMs) / 1000))}s (limit ${timeoutMs}ms)`);
    this.name = 'NodeTimeoutError';
    this.isNodeTimeout = true;
    this.timeoutMs = timeoutMs;
  }
}

export function isNodeTimeoutError(err) {
  return !!(err && (err.isNodeTimeout || err.name === 'NodeTimeoutError'));
}

export function resolveNodeTimeoutConfig(config = {}) {
  const rawMs = config.timeoutMs ?? config.nodeTimeoutMs ?? config.timeout_ms;
  let timeoutMs = Number(rawMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_NODE_TIMEOUT_MS;
  // Clamp: at least 1s, at most 24h
  timeoutMs = Math.min(Math.max(Math.floor(timeoutMs), 1000), 24 * 60 * 60 * 1000);

  const actionRaw = String(config.timeoutAction || config.timeout_action || 'fail')
    .trim()
    .toLowerCase();
  const timeoutAction =
    actionRaw === 'default_output' ||
    actionRaw === 'continue' ||
    actionRaw === 'pass_default' ||
    actionRaw === 'default'
      ? 'default_output'
      : 'fail';

  let defaultOutput = {};
  const rawOut = config.defaultTimeoutOutput ?? config.default_timeout_output ?? '{}';
  if (rawOut != null && typeof rawOut === 'object' && !Array.isArray(rawOut)) {
    defaultOutput = { ...rawOut };
  } else {
    try {
      defaultOutput = JSON.parse(String(rawOut || '{}'));
      if (!defaultOutput || typeof defaultOutput !== 'object' || Array.isArray(defaultOutput)) {
        defaultOutput = { text: String(rawOut || '') };
      }
    } catch {
      defaultOutput = { text: String(rawOut || '') };
    }
  }

  return { timeoutMs, timeoutAction, defaultOutput };
}

/**
 * Race a promise against a timeout. Resolves/rejects with the work result if it
 * finishes first; rejects with NodeTimeoutError if the limit is hit first.
 */
export async function withNodeTimeout(workPromise, timeoutMs) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_NODE_TIMEOUT_MS;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new NodeTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(workPromise), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Base outputs when continuing past a timeout with default_output action. */
export function buildTimeoutFallbackOutputs(nodeType, defaultOutput = {}, timeoutMs) {
  const base = {
    timed_out: true,
    timeout_ms: timeoutMs,
    ok: false,
    text:
      defaultOutput.text != null
        ? String(defaultOutput.text)
        : `Timed out after ${Math.round(timeoutMs / 1000)}s`,
  };

  if (nodeType === 'api') {
    const body = defaultOutput.body !== undefined ? defaultOutput.body : defaultOutput;
    return {
      ...base,
      status: defaultOutput.status != null ? Number(defaultOutput.status) : 0,
      body,
      bodyText:
        defaultOutput.bodyText != null
          ? String(defaultOutput.bodyText)
          : typeof body === 'object'
            ? JSON.stringify(body)
            : String(body ?? base.text),
      ...defaultOutput,
      timed_out: true,
      timeout_ms: timeoutMs,
      ok: defaultOutput.ok === true,
    };
  }

  if (nodeType === 'mcp_tool') {
    return {
      ...base,
      result: defaultOutput.result !== undefined ? defaultOutput.result : defaultOutput,
      latency_ms: 0,
      invoke_kind: defaultOutput.invoke_kind || 'tool',
      ...defaultOutput,
      timed_out: true,
      timeout_ms: timeoutMs,
      ok: defaultOutput.ok === true,
    };
  }

  if (nodeType === 'custom_script') {
    return {
      ...base,
      result: defaultOutput.result !== undefined ? defaultOutput.result : defaultOutput,
      script_id: defaultOutput.script_id || null,
      ...defaultOutput,
      timed_out: true,
      timeout_ms: timeoutMs,
      ok: defaultOutput.ok === true,
    };
  }

  // brain
  return {
    ...base,
    model_used: defaultOutput.model_used || 'timeout',
    provider: defaultOutput.provider || 'timeout',
    mcp_tools_available: defaultOutput.mcp_tools_available ?? 0,
    mcp_tool_calls: defaultOutput.mcp_tool_calls || [],
    custom_script_ran: false,
    custom_script_output: null,
    ...defaultOutput,
    timed_out: true,
    timeout_ms: timeoutMs,
  };
}

/** Merge shared timeout fields onto a node type's configFields list. */
export function withNodeTimeoutConfigFields(configFields = []) {
  const ids = new Set(configFields.map((f) => f.id));
  const merged = [...configFields];
  for (const f of NODE_TIMEOUT_CONFIG_FIELDS) {
    if (ids.has(f.id)) {
      const idx = merged.findIndex((x) => x.id === f.id);
      if (idx >= 0) merged[idx] = { ...merged[idx], ...f, default: f.default };
    } else {
      merged.push(f);
    }
  }
  return merged;
}

export function defaultNodeTimeoutTaskConfig() {
  return {
    timeoutMs: DEFAULT_NODE_TIMEOUT_MS,
    timeoutAction: 'fail',
    defaultTimeoutOutput: '{}',
  };
}
