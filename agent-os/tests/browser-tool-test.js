/**
 * Test OpenClaw browser automation for an agent (default: techresearcher).
 *
 * Usage (from agent-os):
 *   node tests/browser-tool-test.js
 *   node tests/browser-tool-test.js techresearcher
 *
 * Requires: gateway on 18789, OPENCLAW_GATEWAY_TOKEN in backend/.env
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', 'backend', '.env');
try {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
} catch (_) {}

const agentId = process.argv[2] || 'techresearcher';
const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';

function runOpenClaw(args) {
  const env = { ...process.env };
  if (token) env.OPENCLAW_GATEWAY_TOKEN = token;
  const fullArgs = token ? [...args, '--token', token] : args;
  const r = spawnSync('openclaw', fullArgs, { encoding: 'utf8', env, shell: true });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function chat(prompt) {
  const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': agentId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model: 'openclaw',
      messages: [{ role: 'user', content: prompt }],
      user: `browser-test-${agentId}`,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

console.log('=== Browser CLI smoke test (optional) ===');
let cliOk = true;
for (const args of [
  ['browser', '--browser-profile', 'openclaw', 'status'],
  ['browser', '--browser-profile', 'openclaw', 'start'],
]) {
  const { code, stdout, stderr } = runOpenClaw(args);
  console.log(`\n$ openclaw ${args.join(' ')}`);
  console.log('exit', code);
  if (stdout.trim()) console.log(stdout.trim().slice(0, 600));
  if (stderr.trim()) console.log(stderr.trim().slice(0, 400));
  if (code !== 0) {
    cliOk = false;
    if (/pairing required/i.test(stderr + stdout)) {
      console.log('(CLI skipped — WebSocket pairing; agent chat uses HTTP and is the real test)');
    }
    break;
  }
}

console.log('\n=== Agent chat browser test ===');
const prompt =
  'Open https://example.com in the browser, take a snapshot, and reply with the page heading text only.';
const { status, text } = await chat(prompt);
console.log('chat status', status);
console.log(text.slice(0, 2500));
if (status !== 200) process.exit(1);
if (/chrome extension|Browser Relay|can't access the browser/i.test(text)) {
  console.error('Agent still failing browser — ensure TOOLS.md says profile=openclaw');
  process.exit(1);
}
if (!/example domain/i.test(text)) {
  console.error('Unexpected reply — browser may not have run');
  process.exit(1);
}
console.log('\nBrowser tool test passed' + (cliOk ? '' : ' (HTTP chat only)'));
