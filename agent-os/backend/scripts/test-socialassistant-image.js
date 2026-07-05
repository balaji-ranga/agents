/**
 * Test: SocialAssistant receives "generate pad thai image", should call generate_image and hit agent-os backend.
 * Prereq: Backend (3001) and OpenClaw gateway (18789) running; plugin baseUrl = http://127.0.0.1:3001.
 * Run from backend: node scripts/test-socialassistant-image.js
 */
const BACKEND = 'http://127.0.0.1:3001';
const agentId = 'socialasstant';
const message = 'generate pad thai image';

async function getLogs() {
  const r = await fetch(`${BACKEND}/api/tools/logs?limit=5&tool=generate_image`);
  if (!r.ok) throw new Error(`logs ${r.status}`);
  return r.json();
}

async function main() {
  console.log('Sending chat to SocialAssistant:', message);
  const chatRes = await fetch(`${BACKEND}/api/agents/${agentId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, user_id: 'test-session-' + Date.now() }),
  });
  if (!chatRes.ok) {
    console.error('Chat failed:', chatRes.status, await chatRes.text());
    process.exit(1);
  }
  const chat = await chatRes.json();
  console.log('Reply:', chat.reply?.slice(0, 200) + (chat.reply?.length > 200 ? '...' : ''));

  await new Promise((r) => setTimeout(r, 2000));
  const logs = await getLogs();
  const recent = logs.logs || [];
  const hit = recent.some((l) => l.tool_name === 'generate_image');
  if (hit) {
    console.log('SUCCESS: Backend received generate_image call. Recent logs:', recent.length);
    console.log(JSON.stringify(recent[0], null, 2));
    process.exit(0);
  }
  console.log('FAIL: No generate_image call in backend. Total logs:', logs.total);
  if (recent.length) console.log('Recent:', JSON.stringify(recent, null, 2));
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
