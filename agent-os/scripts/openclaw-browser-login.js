/**
 * Interactive login for LinkedIn + JobStreet in OpenClaw managed browser.
 * Saves Playwright storage state for profile=openclaw.
 *
 * Run from agent-os: node scripts/openclaw-browser-login.js
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentOsRoot = join(__dirname, '..');

for (const line of readFileSync(join(agentOsRoot, 'backend', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
}

const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
let token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const cfgPath = join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
if (!token && existsSync(cfgPath)) {
  try {
    token = JSON.parse(readFileSync(cfgPath, 'utf8'))?.gateway?.auth?.token || '';
  } catch (_) {}
}

async function warmup() {
  const res = await fetch(`${gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-openclaw-agent-id': 'jobdiscovery',
    },
    body: JSON.stringify({ tool: 'browser', args: { action: 'start', profile: 'openclaw' } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(await res.text());
}

console.log('\n=== OpenClaw browser login (LinkedIn + JobStreet) ===\n');
console.log('1. Ensure gateway is running (port 18789)');
console.log('2. This script starts managed browser profile=openclaw');
console.log('3. Log in to LinkedIn and JobStreet in the Chromium window');
console.log('4. Return here and press Enter to save session metadata\n');

await warmup();
console.log('Browser warmed up (profile=openclaw).\n');

for (const url of [
  'https://www.linkedin.com/login',
  'https://www.jobstreet.com.sg/',
]) {
  const nav = await fetch(`${gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-openclaw-agent-id': 'jobdiscovery',
    },
    body: JSON.stringify({ tool: 'browser', args: { action: 'open', profile: 'openclaw', url } }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  if (!nav?.ok) {
    console.warn('Could not open in Playwright:', url, '- use the Chromium window manually');
  }
}

console.log('Log in to LinkedIn and JobStreet in the OpenClaw Playwright Chromium window.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => {
  rl.question('Press Enter after you logged in to LinkedIn AND JobStreet in the Playwright window... ', () => {
    rl.close();
    resolve();
  });
});

console.log('Saving browser session (cookies)...');
const persistRes = await fetch(`${gatewayUrl}/tools/invoke`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'x-openclaw-agent-id': 'jobdiscovery',
  },
  body: JSON.stringify({ tool: 'browser', args: { action: 'stop', profile: 'openclaw' } }),
  signal: AbortSignal.timeout(30000),
}).catch(() => null);
if (persistRes?.ok) {
  await fetch(`${gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-openclaw-agent-id': 'jobdiscovery',
    },
    body: JSON.stringify({ tool: 'browser', args: { action: 'start', profile: 'openclaw' } }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
}

const markRes = await fetch(`${process.env.AGENT_OS_PUBLIC_URL || 'http://127.0.0.1:3001'}/api/job-applicant/browser-auth/complete-login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ linkedin: true, jobstreet: true, verify: false }),
}).catch(() => null);

if (markRes?.ok) {
  const data = await markRes.json().catch(() => ({}));
  console.log('\n✓ Session saved.', data.storage_state_exists ? 'Cookies on disk.' : 'Warning: storage file missing — log in again in Chromium.');
} else {
  console.log('\n✓ Login complete in browser. In the UI: Job Profiles → Connect portals → Save & connect.');
}
console.log('Storage state:', join(process.env.USERPROFILE || '', '.openclaw', 'browser', 'openclaw', 'storage-state.json'));
console.log('');
