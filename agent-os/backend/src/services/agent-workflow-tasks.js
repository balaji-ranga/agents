/**
 * Built-in workflow tasks: Send Email, Call API.
 */
import { createConnection } from 'net';
import { connect as tlsConnect } from 'tls';

function smtpFromEnv() {
  return {
    host: process.env.WORKFLOW_SMTP_HOST || '',
    port: Number(process.env.WORKFLOW_SMTP_PORT || 587),
    secure: process.env.WORKFLOW_SMTP_SECURE === '1' || process.env.WORKFLOW_SMTP_SECURE === 'true',
    user: process.env.WORKFLOW_SMTP_USER || '',
    pass: process.env.WORKFLOW_SMTP_PASS || '',
    from: process.env.WORKFLOW_SMTP_FROM || process.env.WORKFLOW_SMTP_USER || 'agent-os@localhost',
  };
}

function resolveSmtpConfig(nodeConfig = {}) {
  if (nodeConfig.useEnvSmtp !== false) {
    const env = smtpFromEnv();
    return {
      host: nodeConfig.smtpHost || env.host,
      port: Number(nodeConfig.smtpPort || env.port || 587),
      secure: nodeConfig.smtpSecure ?? env.secure,
      user: nodeConfig.smtpUser || env.user,
      pass: nodeConfig.smtpPass || env.pass,
      from: nodeConfig.fromAddress || env.from,
    };
  }
  return {
    host: nodeConfig.smtpHost || '',
    port: Number(nodeConfig.smtpPort || 587),
    secure: !!nodeConfig.smtpSecure,
    user: nodeConfig.smtpUser || '',
    pass: nodeConfig.smtpPass || '',
    from: nodeConfig.fromAddress || nodeConfig.smtpUser || 'agent-os@localhost',
  };
}

/** Minimal SMTP client — attempts send; returns attempt result even on failure. */
function sendSmtpMail({ host, port, secure, user, pass, from, to, cc, subject, body }) {
  return new Promise((resolve) => {
    const recipients = [to, cc].filter(Boolean).join(', ');
    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ];
    const message = lines.join('\r\n');

    if (!host) {
      return resolve({
        sent: false,
        attempted: true,
        error: 'SMTP host not configured (set WORKFLOW_SMTP_HOST or node smtpHost)',
        messageId: null,
      });
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ sent: false, attempted: true, error: 'SMTP connection timeout', messageId: null });
    }, 15000);

    let socket;
    let buffer = '';
    let stage = 'connect';
    const responses = [];

    function cleanup() {
      clearTimeout(timeout);
      try {
        socket?.destroy();
      } catch (_) {}
    }

    function fail(err) {
      cleanup();
      resolve({ sent: false, attempted: true, error: err, messageId: null });
    }

    function send(line) {
      socket.write(`${line}\r\n`);
    }

    function onData(data) {
      buffer += data.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const line of parts) {
        if (!line) continue;
        responses.push(line);
        const code = parseInt(line.slice(0, 3), 10);
        if (Number.isNaN(code)) continue;

        if (stage === 'connect' && code === 220) {
          send(`EHLO agent-os`);
          stage = 'ehlo';
        } else if (stage === 'ehlo' && code >= 250) {
          if (user && pass) {
            send('AUTH LOGIN');
            stage = 'auth-user';
          } else {
            send(`MAIL FROM:<${from}>`);
            stage = 'mail-from';
          }
        } else if (stage === 'auth-user' && code === 334) {
          send(Buffer.from(user).toString('base64'));
          stage = 'auth-pass';
        } else if (stage === 'auth-pass' && code === 334) {
          send(Buffer.from(pass).toString('base64'));
          stage = 'auth-wait';
        } else if (stage === 'auth-wait' && code >= 250) {
          send(`MAIL FROM:<${from}>`);
          stage = 'mail-from';
        } else if (stage === 'mail-from' && code >= 250) {
          send(`RCPT TO:<${to}>`);
          stage = 'rcpt';
        } else if (stage === 'rcpt' && code >= 250) {
          send('DATA');
          stage = 'data-wait';
        } else if (stage === 'data-wait' && code === 354) {
          send(message);
          send('.');
          stage = 'data-done';
        } else if (stage === 'data-done' && code >= 250) {
          send('QUIT');
          cleanup();
          const mid = line.match(/queued as (\S+)/i)?.[1] || `local-${Date.now()}`;
          resolve({ sent: true, attempted: true, error: null, messageId: mid, to: recipients });
        } else if (code >= 400) {
          fail(line);
        }
      }
    }

    try {
      if (secure && port === 465) {
        socket = tlsConnect({ host, port, rejectUnauthorized: false }, () => {});
      } else {
        socket = createConnection({ host, port }, () => {});
      }
      socket.on('data', onData);
      socket.on('error', (e) => fail(e.message));
      socket.on('close', () => {
        if (stage !== 'data-done') fail(`Connection closed (${stage})`);
      });
    } catch (e) {
      fail(e.message);
    }
  });
}

/**
 * Send email task. Always returns outputs object; does not throw on SMTP failure.
 */
export async function executeEmailTask(resolvedInputs, nodeConfig = {}) {
  const to = resolvedInputs.to?.trim();
  const subject = resolvedInputs.subject?.trim() || '(no subject)';
  const body = resolvedInputs.body?.trim() || '';
  const cc = resolvedInputs.cc?.trim() || '';

  if (!to) {
    return { sent: false, attempted: false, error: 'To address is required', messageId: null };
  }
  if (!body) {
    return { sent: false, attempted: false, error: 'Email body is required', messageId: null };
  }

  const smtp = resolveSmtpConfig(nodeConfig);
  const result = await sendSmtpMail({
    ...smtp,
    to,
    cc,
    subject,
    body,
  });

  return {
    sent: !!result.sent,
    attempted: !!result.attempted,
    messageId: result.messageId || null,
    error: result.error || null,
    to,
    subject,
    bodyLength: body.length,
  };
}

/**
 * HTTP API call task.
 */
import { renderWorkflowTemplates } from './agent-workflow-io.js';
import { buildApiRequestHeaders, renderApiNodeConfig } from './agent-workflow-api-auth.js';
import { assertHttpSuccess, wrapFetchError } from './workflow-http-errors.js';

export async function executeApiTask(resolvedInputs, nodeConfig = {}, context = null) {
  const render = (v) => (context && v != null ? renderWorkflowTemplates(String(v), context) : v);
  const cfg = context ? renderApiNodeConfig(nodeConfig, context) : nodeConfig;

  const url = render(resolvedInputs.url)?.trim();
  if (!url) throw new Error('API URL is required');

  const method = (cfg.method || 'POST').toUpperCase();
  const timeoutMs = Number(cfg.timeoutMs || 60000);

  let headers = buildApiRequestHeaders(cfg, context, resolvedInputs.headers);

  let body = render(resolvedInputs.body);
  if (body && method !== 'GET' && method !== 'HEAD') {
    try {
      JSON.parse(body);
    } catch {
      headers['Content-Type'] = 'text/plain';
    }
  }

  let response;
  let text;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (err) {
    wrapFetchError(err, `API ${method} ${url}`);
  }

  assertHttpSuccess(response, text);

  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch (_) {}

  return {
    ok: true,
    status: response.status,
    body: parsed,
    bodyText: text.slice(0, 5000),
  };
}
