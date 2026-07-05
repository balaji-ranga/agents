/**
 * OpenClaw Gateway cron tool - schedule one-shot or recurring jobs via POST /tools/invoke.
 * See https://docs.openclaw.ai/cron-jobs and https://docs.openclaw.ai/gateway/tools-invoke-http-api
 */

const DEFAULT_PORT = 18789;

function getGatewayUrl() {
  const base = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
  return base.replace(/\/$/, '');
}

function getGatewayToken() {
  return process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_PASSWORD || '';
}

/**
 * Add a one-shot cron job that runs immediately (or at a given time), targets an agent,
 * and delivers the result to a webhook.
 * @param {Object} opts
 * @param {string} opts.name - Job name (unique enough for debugging)
 * @param {string} opts.agentId - OpenClaw agent id (e.g. 'techresearcher')
 * @param {string} opts.message - User message / prompt for the agent
 * @param {string} opts.webhookUrl - Full URL for delivery.to (webhook)
 * @param {string} [opts.at] - ISO 8601 time; default is now
 * @returns {Promise<{ jobId?: string, ok: boolean, error?: string }>}
 */
export async function cronAddOneShotWebhook({ name, agentId, message, webhookUrl, at }) {
  const url = `${getGatewayUrl()}/tools/invoke`;
  const token = getGatewayToken();
  const atTime = at || new Date().toISOString();

  const args = {
    name: name || `agent-os-${Date.now()}`,
    schedule: { kind: 'at', at: atTime },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: message || 'Report status.',
    },
    delivery: {
      mode: 'webhook',
      to: webhookUrl,
    },
    deleteAfterRun: true,
    ...(agentId ? { agentId } : {}),
  };
  const body = { tool: 'cron.add', args };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    let res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    let data = await res.json().catch(() => ({}));
    if (res.status === 404 && body.tool === 'cron.add') {
      body.tool = 'cron_add';
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      data = await res.json().catch(() => ({}));
    }
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.error || res.statusText;
      return { ok: false, error: errMsg };
    }
    const jobId = data?.result?.jobId ?? data?.result?.id;
    return { ok: true, jobId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
