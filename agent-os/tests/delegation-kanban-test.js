/**
 * End-to-end API test:
 * - creates a standup
 * - sends the CEO prompt (delegation to agents + kanban tasks)
 * - runs delegation processing loop
 * - verifies techresearcher + expensemanager invoked kanban_move_status (via content_tool_logs)
 *
 * Run: node tests/delegation-kanban-test.js
 * Optional env:
 *   BASE_URL=http://127.0.0.1:3001
 *   PROMPT="..."
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const PROMPT =
  process.env.PROMPT ||
  'Generate research content on Nvidia chip technology and Nvidia income and expense report';

async function parseJsonOrText(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const data = await parseJsonOrText(res);
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await parseJsonOrText(res);
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const agents = await get('/agents');
  const ids = agents.map((a) => a.id);
  console.log('agents:', ids.join(','));

  const need = ['techresearcher', 'expensemanager'];
  for (const n of need) {
    if (!ids.includes(n)) throw new Error(`Missing agent ${n}`);
  }

  const standup = await post('/standups', { source: 'manual', status: 'scheduled', title: 'Tool access test' });
  console.log('standup:', standup.id);

  const msg = await post(`/standups/${standup.id}/messages`, { content: PROMPT });
  const taskIds = msg.kanban_task_ids || [];
  console.log('delegated tasks_queued:', msg.tasks_queued, 'kanban_task_ids:', taskIds.join(','));
  if (taskIds.length === 0) throw new Error('No kanban tasks created');

  let done = false;
  for (let i = 0; i < 12 && !done; i++) {
    // fallback runner in case cron wasn't scheduled (or for fast local)
    await post('/api/cron/process-delegations', {}).catch(() => {});

    const tasks = await Promise.all(taskIds.map((id) => get(`/api/kanban/tasks/${id}`)));
    const statuses = tasks.map((t) => (t.task && t.task.status) || t.status || t.task_status);
    console.log('poll', i, 'statuses:', JSON.stringify(statuses));
    done = statuses.every((s) => s === 'completed' || s === 'failed');
    if (!done) await sleep(5000);
  }

  const finalTasks = await Promise.all(taskIds.map((id) => get(`/api/kanban/tasks/${id}`)));
  for (const t of finalTasks) {
    const task = t.task || t;
    console.log(
      'task',
      task.id,
      'assigned',
      task.assigned_agent_id,
      'status',
      task.status,
      'has_prompt',
      !!t.delegation_prompt,
      'has_response',
      !!t.delegation_response
    );
  }

  const logs = await get('/api/tools/logs?limit=200&tool=kanban_move_status');
  const sources = new Set((logs.logs || []).map((r) => r.source).filter(Boolean).map((s) => String(s).toLowerCase()));
  console.log('kanban_move_status log sources:', Array.from(sources).join(','));

  const ok = need.every((n) => sources.has(n));
  if (!ok) {
    throw new Error('Missing kanban_move_status logs for techresearcher and/or expensemanager');
  }
  console.log('PASS: both agents invoked kanban_move_status');
}

run().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});

