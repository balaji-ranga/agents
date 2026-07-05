/**
 * Pre-start OpenClaw managed browser (profile=openclaw) via gateway HTTP /tools/invoke.
 * Run after gateway is up: node scripts/warmup-openclaw-browser.js
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', 'backend', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}

const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
let token = process.env.OPENCLAW_GATEWAY_TOKEN || '';

const openclawConfigPath = join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
if (!token && existsSync(openclawConfigPath)) {
  try {
    const cfg = JSON.parse(readFileSync(openclawConfigPath, 'utf8'));
    token = cfg?.gateway?.auth?.token || '';
  } catch (_) {}
}

async function waitForGateway(maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'OPTIONS',
        signal: AbortSignal.timeout(2000),
      });
      if (res.status < 500) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function main() {
  if (!(await waitForGateway())) {
    console.warn('Gateway not reachable at', gatewayUrl);
    process.exit(1);
  }
  const res = await fetch(`${gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-openclaw-agent-id': 'balserve',
    },
    body: JSON.stringify({
      tool: 'browser',
      args: { action: 'start', profile: 'openclaw' },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('Browser warmup failed', res.status, text.slice(0, 500));
    process.exit(1);
  }
  console.log('Browser warmup OK (profile=openclaw)');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
