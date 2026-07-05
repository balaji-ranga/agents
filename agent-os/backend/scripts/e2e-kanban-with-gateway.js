/**
 * E2E test: standup message → intent → 2 Kanban tasks → OpenClaw gateway runs agents → callbacks move tasks.
 * Run from agent-os: node backend/scripts/e2e-kanban-with-gateway.js
 * Prereq: Backend (3001) running; OpenClaw gateway (18789) running; gateway must be able to POST to backend (AGENT_OS_BASE_URL or http://127.0.0.1:3001).
 */
const API = process.env.API_BASE || process.env.AGENT_OS_BASE_URL || 'http://127.0.0.1:3001';
const GATEWAY = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const PROMPT = 'Create an indian cuisine recipe and do deep research on AI tech';
const POLL_MS = 8000;
const MAX_WAIT_MS = 420000; // 7 min (2 agents × ~3min chat timeout + buffer)

async function req(method, path, body = null) {
  const url = path.startsWith('http') ? path : `${API.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  console.log('E2E Kanban + OpenClaw gateway test');
  console.log('Prompt:', PROMPT);
  console.log('Expected: 2 tasks (TechResearcher, SocialAssistant)\n');

  console.log('1. Backend health…');
  await req('GET', '/api/health');
  console.log('   OK');

  console.log('2. Gateway reachable…');
  try {
    const gwRes = await fetch(`${GATEWAY.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
    if (gwRes.ok) console.log('   OK');
    else console.log('   Warning: gateway returned', gwRes.status);
  } catch (e) {
    console.log('   Warning: gateway not reachable at', GATEWAY, '-', e.message);
    console.log('   Start with: openclaw gateway --port 18789');
  }

  console.log('3. Create standup and send message…');
  const standup = await req('POST', '/api/standups', {});
  const standupId = standup.id;
  const msgRes = await req('POST', `/api/standups/${standupId}/messages`, { content: PROMPT });
  console.log('   Standup id:', standupId);
  console.log('   COO reply:', (msgRes.coo_reply || '').slice(0, 120) + '…');
  const kanbanIds = msgRes.kanban_task_ids || [];
  if (kanbanIds.length > 0) console.log('   Kanban task ids:', kanbanIds);

  console.log('4. Verify Kanban tasks created…');
  const list = await req('GET', '/api/kanban/tasks?view=weekly&limit=20');
  const tasks = list.tasks || [];
  const ourTasks = tasks.filter((t) => t.title && (t.title.includes('recipe') || t.title.includes('research') || t.title.includes('AI')));
  if (ourTasks.length < 2) {
    console.log('   Tasks in board:', tasks.length, tasks.map((t) => ({ id: t.id, title: t.title?.slice(0, 40), assigned: t.assigned_agent_id })));
  }
  const techTask = tasks.find((t) => t.assigned_agent_id === 'techresearcher' && (t.title || '').toLowerCase().includes('research'));
  const socialTask = tasks.find((t) => t.assigned_agent_id === 'socialasstant' && (t.title || '').toLowerCase().includes('recipe'));
  if (techTask) console.log('   TechResearcher task:', techTask.id, techTask.title?.slice(0, 50));
  if (socialTask) console.log('   SocialAssistant task:', socialTask.id, socialTask.title?.slice(0, 50));
  if (!techTask || !socialTask) {
    console.log('   Expected 2 tasks (techresearcher + socialasstant). Found:', tasks.length);
  } else {
    console.log('   OK – 2 tasks found');
  }

  console.log('5. Wait for agents to run and call kanban_move_status (gateway runs agents → agents call tool → task status updated)…');
  const start = Date.now();
  let bothDone = false;
  let lastStatus = '';
  let triggeredFallback = false;
  while (Date.now() - start < MAX_WAIT_MS) {
    const kList = await req('GET', '/api/kanban/tasks?view=weekly&limit=50');
    const kTasks = (kList.tasks || []).filter((t) => t.id === techTask?.id || t.id === socialTask?.id);
    const tech = kTasks.find((t) => t.id === techTask?.id);
    const social = kTasks.find((t) => t.id === socialTask?.id);
    const status = [
      tech ? `TechResearcher: ${tech.status}` : 'TechResearcher: ?',
      social ? `SocialAssistant: ${social.status}` : 'SocialAssistant: ?',
    ].join('; ');
    if (status !== lastStatus) {
      console.log('   ', new Date().toISOString().slice(11, 19), status);
      lastStatus = status;
    }
    const completed = (t) => t && (t.status === 'completed' || t.status === 'failed');
    if (completed(tech) && completed(social)) {
      bothDone = true;
      break;
    }
    // After 30s if not both done, trigger process-delegations fallback once (runs agents via chat if gateway cron didn't fire)
    if (!triggeredFallback && Date.now() - start > 30000) {
      console.log('   Triggering process-delegations (fallback)...');
      triggeredFallback = true;
      try {
        await req('POST', '/api/cron/process-delegations');
      } catch (e) {
        console.log('   process-delegations error:', e.message);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log('6. Content tool logs (kanban_move_status)…');
  const kanbanMoveRes = await req('GET', '/api/tools/logs?limit=20&tool=kanban_move_status');
  const kanbanMoveLogs = kanbanMoveRes.logs || [];
  if (kanbanMoveLogs.length > 0) {
    const fmt = (l) => {
      try {
        const p = typeof l.request_payload === 'string' ? JSON.parse(l.request_payload) : l.request_payload || {};
        return `task ${p.task_id ?? '?'} → ${p.new_status ?? '?'} (${l.status})`;
      } catch (_) { return `${l.status}`; }
    };
    console.log('   Found', kanbanMoveLogs.length, 'kanban_move_status call(s) (agents moved status):', kanbanMoveLogs.map(fmt).join('; '));
  } else {
    console.log('   No kanban_move_status calls in logs (status moves only when agents call the tool; ensure gateway runs agents with tools and passes caller_agent_id).');
  }

  const agentsMovedStatus = kanbanMoveLogs.length > 0 && kanbanMoveLogs.some((l) => l.status === 'ok');
  if (bothDone && agentsMovedStatus) {
    console.log('\n✓ PASS: Both tasks reached completed/failed and agents called kanban_move_status (only agents move status).');
  } else if (bothDone && !agentsMovedStatus) {
    console.log('\n✗ FAIL: Tasks reached completed/failed but no agent kanban_move_status calls in logs. Restart backend and ensure only agents update Kanban.');
    process.exitCode = 1;
  } else {
    console.log('\n✗ TIMEOUT: Not all tasks completed within', MAX_WAIT_MS / 1000, 's.');
    console.log('   Ensure OpenClaw gateway is running, agents have agent-os-content-tools, and gateway can POST to', API, '(cron-callback).');
    process.exitCode = 1;
  }

  console.log('\nDone. Standup', standupId, '| Kanban: /kanban');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
