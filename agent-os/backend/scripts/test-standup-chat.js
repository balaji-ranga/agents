/**
 * Test standup chat flow: create standup, chat with COO, get work from team.
 * Run from backend: node scripts/test-standup-chat.js
 * Prereq: Backend (3001) and OpenClaw gateway (18789) running.
 */
const API = process.env.API_BASE || 'http://127.0.0.1:3001';

async function req(method, path, body = null) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  console.log('1. Health…');
  await req('GET', '/health');
  console.log('   OK');

  console.log('2. Create standup…');
  const standup = await req('POST', '/standups', { scheduled_at: new Date().toISOString(), status: 'scheduled' });
  const id = standup.id;
  console.log('   Standup id:', id);

  console.log('3. Send message to COO (chat)…');
  const chatRes = await req('POST', `/standups/${id}/messages`, { content: 'Hello COO, ready for standup.' });
  console.log('   Messages:', chatRes.messages?.length);
  console.log('   COO reply (excerpt):', (chatRes.coo_reply || '').slice(0, 120) + '…');

  console.log('4. Get work from team (COO delegates via Message API)…');
  const workRes = await req('POST', `/standups/${id}/messages`, { action: 'get_work_from_team' });
  console.log('   Responses from agents:', workRes.responses?.length);
  console.log('   COO reply (excerpt):', (workRes.coo_reply || '').slice(0, 150) + '…');

  console.log('\nDone. Standup', id, '— open Dashboard and select this standup to see the chat.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
