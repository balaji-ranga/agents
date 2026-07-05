/**
 * Test TechResearcher with a sample prompt (e.g. "Status update").
 * Sends POST /api/agents/techresearcher/chat and prints reply or error.
 * Requires: backend running (port 3001), OpenClaw gateway running (18789).
 * Run from agent-os: node backend/scripts/test-techresearcher-chat.js
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const AGENT_ID = 'techresearcher';
const MESSAGE = process.argv[2] || 'Status update';

async function main() {
  console.log('Sending to TechResearcher:', MESSAGE);
  console.log('POST', `${BASE}/api/agents/${AGENT_ID}/chat`);
  const res = await fetch(`${BASE}/api/agents/${AGENT_ID}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: MESSAGE }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Error', res.status, data);
    process.exit(1);
  }
  console.log('Reply:', data.reply || data);
  if (data.usage) console.log('Usage:', data.usage);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
