/**
 * Probe OpenClaw gateway tool calling output.
 *
 * Usage:
 *   node tests/openclaw-toolprobe.js techresearcher "your prompt"
 *
 * Env:
 *   GATEWAY_URL=http://127.0.0.1:18789
 *   GATEWAY_TOKEN=... (or uses OPENCLAW_GATEWAY_TOKEN)
 */
import { readFileSync } from 'fs';

const agentId = process.argv[2] || 'techresearcher';
const promptFromArgs = process.argv.slice(3).join(' ');
let prompt = promptFromArgs || 'Call the kanban_move_status tool with {"task_id": 31, "new_status": "in_progress"}';
if (process.env.PROMPT_FILE) {
  try {
    prompt = readFileSync(process.env.PROMPT_FILE, 'utf8');
  } catch {}
}

const GATEWAY_URL = process.env.GATEWAY_URL || process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
let token = process.env.GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || '';

// Fallback: read token from ~/.openclaw/openclaw.json if present.
if (!token) {
  try {
    const cfg = JSON.parse(readFileSync(`${process.env.USERPROFILE}\\.openclaw\\openclaw.json`, 'utf8'));
    token = cfg?.gateway?.auth?.token || '';
  } catch {}
}

async function run() {
  const res = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': agentId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model: 'openclaw',
      messages: [{ role: 'user', content: prompt }],
      ...(process.env.SESSION_USER ? { user: process.env.SESSION_USER } : {}),
    }),
  });
  const text = await res.text();
  console.log('status', res.status);
  console.log(text);
  if (!res.ok) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

