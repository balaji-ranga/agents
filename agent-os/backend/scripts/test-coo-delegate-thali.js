/**
 * Test COO delegation: "Create an indian thali recipe with image" should delegate to SocialAssistant.
 * Run from backend: node scripts/test-coo-delegate-thali.js
 * Prereq: Backend (3001) running; OpenClaw gateway (18789) optional for full cron flow.
 */
const API = process.env.API_BASE || 'http://127.0.0.1:3001';
const PROMPT = 'Create an indian thali recipe with image';

async function req(method, path, body = null) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  console.log('COO delegation test: "' + PROMPT + '" -> should pick SocialAssistant\n');

  console.log('1. Health…');
  await req('GET', '/health');
  console.log('   OK');

  console.log('2. Create standup…');
  const standup = await req('POST', '/api/standups', {
    scheduled_at: new Date().toISOString(),
    status: 'scheduled',
  });
  const id = standup.id;
  console.log('   Standup id:', id);

  console.log('3. Send message to COO (delegation)…');
  const res = await req('POST', `/api/standups/${id}/messages`, { content: PROMPT });
  const cooReply = res.coo_reply || '';

  console.log('   COO reply:', cooReply);

  // Success = COO says it asked someone (e.g. "I've asked ... to look into this"); expect SocialAssistant
  const delegated = /I've asked .+ to look into this/i.test(cooReply);
  const hasSocial = /SocialAssistant|socialasstant/i.test(cooReply);
  if (delegated && hasSocial) {
    console.log('\n✓ PASS: COO delegated to SocialAssistant.');
  } else if (delegated) {
    console.log('\n✓ PASS: COO delegated to agent(s). Reply:', cooReply.slice(0, 120) + '…');
  } else {
    console.log('\n✗ FAIL: No delegation. COO replied directly. Intent may not have matched or COO AGENTS.md may lack socialasstant.');
    process.exit(1);
  }
  console.log('\nStandup', id, '— open Dashboard and select this standup to see the chat and Check for updates.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
