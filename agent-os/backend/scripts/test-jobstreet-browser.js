/**
 * JobStreet browser test via gateway (same path as browser-tool-test.js).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
}

const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
const token = process.env.OPENCLAW_GATEWAY_TOKEN || '';

const prompt = `[ceo_user_id: default]
Use browser with profile=openclaw only.
1. Navigate to https://www.jobstreet.com.sg/jobs?keywords=SVP%20technology%20banking&location=Singapore
2. Click the first relevant job listing
3. Reply with: exact URL, company name, job title (one job only)`;

const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-openclaw-agent-id': 'jobdiscovery',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({
    model: 'openclaw',
    messages: [{ role: 'user', content: prompt }],
    user: 'jobstreet-browser-test',
  }),
  signal: AbortSignal.timeout(300000),
});

const text = await res.text();
console.log('status', res.status);
try {
  const data = JSON.parse(text);
  console.log('reply:', data.choices?.[0]?.message?.content || text.slice(0, 2000));
} catch {
  console.log(text.slice(0, 2000));
}
