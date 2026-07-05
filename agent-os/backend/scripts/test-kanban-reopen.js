/**
 * Test: Kanban reopen does NOT auto-call agent; Send after reopen DOES get agent reply.
 * Usage: node backend/scripts/test-kanban-reopen.js
 */
const API = process.env.API_BASE || 'http://127.0.0.1:3001';

async function req(method, path, body = null) {
  const url = `${API.replace(/\/$/, '')}/api${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return data;
}

function messageSummary(detail) {
  return (detail.messages || []).map((m) => ({
    id: m.id,
    role: m.role,
    preview: String(m.content || '').slice(0, 80).replace(/\s+/g, ' '),
  }));
}

async function main() {
  console.log('=== Kanban reopen + Send behavior test ===\n');

  await req('GET', '/health');
  console.log('Backend OK\n');

  const agents = await req('GET', '/agents');
  const agent = agents.find((a) => !a.is_coo && a.openclaw_agent_id) || agents.find((a) => !a.is_coo);
  if (!agent) throw new Error('No non-COO agent found');
  console.log('Using agent:', agent.id, `(${agent.name})`);

  const created = await req('POST', '/kanban/tasks', {
    title: `[reopen-test] Quick ping ${Date.now()}`,
    description: 'Automated reopen test — reply with one short sentence only.',
    assign_to: agent.id,
  });
  const taskId = created.id;
  console.log('Created task:', taskId, 'status:', created.status);

  await req('PATCH', `/kanban/tasks/${taskId}`, { status: 'completed' });
  console.log('Marked completed\n');

  const beforeReopen = await req('GET', `/kanban/tasks/${taskId}`);
  const msgsBefore = beforeReopen.messages?.length || 0;
  console.log('--- Step 1: Reopen only (no Send) ---');
  console.log('Messages before reopen:', msgsBefore);

  const reopened = await req('POST', `/kanban/tasks/${taskId}/reopen`, {});
  console.log('Reopen response status:', reopened.status);

  await new Promise((r) => setTimeout(r, 5000));

  const afterReopen = await req('GET', `/kanban/tasks/${taskId}`);
  const msgsAfterReopen = afterReopen.messages?.length || 0;
  const assistantAfterReopen = (afterReopen.messages || []).filter((m) => m.role === 'assistant').length;

  console.log('Status after reopen:', afterReopen.status);
  console.log('Messages after reopen:', msgsAfterReopen, '(delta:', msgsAfterReopen - msgsBefore, ')');
  console.log('Assistant messages after reopen:', assistantAfterReopen);

  const reopenAloneTriggeredAgent = msgsAfterReopen > msgsBefore;
  console.log(
    reopenAloneTriggeredAgent
      ? 'FAIL: Reopen alone added messages (unexpected)'
      : 'PASS: Reopen alone did NOT call agent / add messages'
  );

  console.log('\n--- Step 2: Send message after reopen ---');
  const followUp = 'Please reply with exactly: REOPEN_TEST_OK';
  await req('POST', `/kanban/tasks/${taskId}/messages`, { role: 'user', content: followUp });
  console.log('Sent:', followUp);

  const afterSend = await req('GET', `/kanban/tasks/${taskId}`);
  const msgsAfterSend = afterSend.messages?.length || 0;
  const lastAssistant = [...(afterSend.messages || [])].reverse().find((m) => m.role === 'assistant');

  console.log('Messages after Send:', msgsAfterSend, '(delta from reopen:', msgsAfterSend - msgsAfterReopen, ')');
  console.log('Last assistant reply:', lastAssistant ? lastAssistant.content.slice(0, 200) : '(none)');

  const sendGotReply = !!lastAssistant && msgsAfterSend > msgsAfterReopen;
  console.log(
    sendGotReply
      ? 'PASS: Send after reopen received agent reply'
      : 'FAIL: No agent reply after Send (gateway down or agent error?)'
  );

  console.log('\n=== Summary ===');
  console.log('Reopen alone triggers agent:', reopenAloneTriggeredAgent ? 'YES (bug?)' : 'NO');
  console.log('Send after reopen gets reply:', sendGotReply ? 'YES' : 'NO');
  console.log('Message log:', JSON.stringify(messageSummary(afterSend), null, 2));

  try {
    await req('DELETE', `/kanban/tasks/${taskId}`);
    console.log('\nCleaned up test task', taskId);
  } catch (e) {
    console.log('\nCleanup skipped:', e.message);
  }

  if (reopenAloneTriggeredAgent || !sendGotReply) process.exit(1);
}

main().catch((e) => {
  console.error('Test error:', e.message);
  process.exit(1);
});
