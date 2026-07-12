/**
 * SMTP delivery diagnostic with full transcript.
 * Usage: node scripts/diag-smtp-send.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createConnection } from 'net';
import { connect as tlsConnect } from 'tls';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const host = process.env.WORKFLOW_SMTP_HOST;
const port = Number(process.env.WORKFLOW_SMTP_PORT || 587);
const user = (process.env.WORKFLOW_SMTP_USER || '').trim();
const pass = (process.env.WORKFLOW_SMTP_PASS || '').trim();
const from = (process.env.WORKFLOW_SMTP_FROM || '').trim();
const to = (process.env.WORKFLOW_TEST_EMAIL_TO || '').trim();
const stamp = new Date().toISOString();
const subject = `Agent OS SMTP TRACE ${stamp}`;

console.log({
  host,
  port,
  user,
  from,
  to,
  pass_len: pass.length,
  pass_has_whitespace: /\s/.test(pass),
});

function isComplete(line) {
  return line.length >= 4 && line[3] === ' ';
}

await new Promise((resolve) => {
  let socket = createConnection({ host, port });
  let buf = '';
  let stage = 'connect';
  let finished = false;

  const finish = (ok, msg) => {
    if (finished) return;
    finished = true;
    try {
      socket.end();
    } catch {
      /* ignore */
    }
    console.log(ok ? 'SUCCESS' : 'FAIL', msg);
    resolve(ok);
  };

  const logLine = (dir, line) => {
    if (stage === 'auth-pass' && dir === '>>') console.log(dir, '[base64 password]');
    else if (line.length > 120) console.log(dir, `${line.slice(0, 80)}… (${line.length} chars)`);
    else console.log(dir, line);
  };

  const send = (line) => {
    logLine('>>', line);
    socket.write(`${line}\r\n`);
  };

  const handle = (line) => {
    logLine('<<', line);
    const code = parseInt(line.slice(0, 3), 10);
    const complete = isComplete(line);

    if (stage === 'connect' && code === 220) {
      send('EHLO agent-os');
      stage = 'ehlo';
      return;
    }
    if (stage === 'ehlo' && complete && code >= 200 && code < 300) {
      send('STARTTLS');
      stage = 'starttls';
      return;
    }
    if (stage === 'starttls' && code === 220) {
      socket.removeAllListeners('data');
      const plain = socket;
      socket = tlsConnect({ socket: plain, servername: host, rejectUnauthorized: false }, () => {
        socket.on('data', onData);
        send('EHLO agent-os');
        stage = 'ehlo-tls';
      });
      socket.on('error', (e) => finish(false, e.message));
      return;
    }
    if (stage === 'ehlo-tls' && complete && code >= 200 && code < 300) {
      send('AUTH LOGIN');
      stage = 'auth-user';
      return;
    }
    if (stage === 'auth-user' && code === 334) {
      send(Buffer.from(user).toString('base64'));
      stage = 'auth-pass';
      return;
    }
    if (stage === 'auth-pass' && code === 334) {
      send(Buffer.from(pass).toString('base64'));
      stage = 'auth-wait';
      return;
    }
    if (stage === 'auth-wait' && complete && code >= 200 && code < 300) {
      send(`MAIL FROM:<${from}>`);
      stage = 'mail';
      return;
    }
    if (stage === 'mail' && complete && code >= 200 && code < 300) {
      send(`RCPT TO:<${to}>`);
      stage = 'rcpt';
      return;
    }
    if (stage === 'rcpt' && complete && code >= 200 && code < 300) {
      send('DATA');
      stage = 'data';
      return;
    }
    if (stage === 'data' && code === 354) {
      const msg = [
        `From: ${from}`,
        `To: ${to}`,
        `Reply-To: ${from}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Trace send at ${stamp}.`,
        'If this arrives, SMTP path is fine — check Brevo transactional logs for earlier queued messages.',
      ].join('\r\n');
      socket.write(`${msg}\r\n.\r\n`);
      stage = 'quit';
      return;
    }
    if (stage === 'quit' && complete && code >= 200 && code < 300) {
      send('QUIT');
      finish(true, line);
      return;
    }
    if (complete && code >= 400) finish(false, line);
  };

  function onData(data) {
    buf += data.toString();
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || '';
    for (const line of parts) {
      if (line) handle(line);
    }
  }

  socket.on('data', onData);
  socket.on('error', (e) => finish(false, e.message));
  setTimeout(() => finish(false, `timeout stage=${stage}`), 20000);
});

console.log('\nLook for subject:', subject);
