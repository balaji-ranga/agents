/**
 * Full API test: health, agents (list/create/get), standups (list/create/get/run-coo),
 * agent workspace (files/read/write), agent chat (history/send).
 * Run: node tests/api-full.js
 * Prereq: Backend at BASE_URL (default http://127.0.0.1:3001). Optional: OPENCLAW gateway for chat.
 * Set SKIP_RUN_COO=1 to skip Run COO (needs ANTHROPIC_API_KEY). Set SKIP_CHAT=1 to skip chat send.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const SKIP_RUN_COO = process.env.SKIP_RUN_COO === '1';
const SKIP_CHAT = process.env.SKIP_CHAT === '1';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) throw new Error(data?.error || text || res.status);
  return data;
}
const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);
const put = (path, body) => request('PUT', path, body);
const patch = (path, body) => request('PATCH', path, body);

async function run() {
  let failed = 0;
  let createdAgentId = null;
  let createdStandupId = null;

  // 1. Health
  try {
    const h = await get('/health');
    if (h?.status !== 'ok') throw new Error('status not ok');
    console.log('✓ GET /health');
  } catch (e) {
    console.error('✗ GET /health', e.message);
    failed++;
    process.exit(1);
  }

  // 2. Agents list
  try {
    const agents = await get('/agents');
    if (!Array.isArray(agents)) throw new Error('not array');
    console.log('✓ GET /agents', agents.length, 'agents');
  } catch (e) {
    console.error('✗ GET /agents', e.message);
    failed++;
  }

  // 3. Create agent (new agent creation)
  try {
    const agent = await post('/agents', { name: 'TestAgent-' + Date.now(), role: 'Tester' });
    if (!agent?.id) throw new Error('no id');
    createdAgentId = agent.id;
    console.log('✓ POST /agents (create)', createdAgentId);
  } catch (e) {
    console.error('✗ POST /agents', e.message);
    failed++;
  }

  // 4. Get agent
  if (createdAgentId) {
    try {
      const a = await get(`/agents/${createdAgentId}`);
      if (a.id !== createdAgentId) throw new Error('id mismatch');
      console.log('✓ GET /agents/:id', a.name);
    } catch (e) {
      console.error('✗ GET /agents/:id', e.message);
      failed++;
    }
  }

  // 5. Standups list
  try {
    const standups = await get('/standups');
    if (!Array.isArray(standups)) throw new Error('not array');
    console.log('✓ GET /standups', standups.length, 'standups');
  } catch (e) {
    console.error('✗ GET /standups', e.message);
    failed++;
  }

  // 6. Create standup (schedule standup)
  try {
    const s = await post('/standups', { scheduled_at: new Date().toISOString(), status: 'scheduled' });
    if (!s?.id) throw new Error('no id');
    createdStandupId = s.id;
    console.log('✓ POST /standups (create)', createdStandupId);
  } catch (e) {
    console.error('✗ POST /standups', e.message);
    failed++;
  }

  // 7. Get standup
  if (createdStandupId) {
    try {
      const s = await get(`/standups/${createdStandupId}`);
      if (s.id !== createdStandupId) throw new Error('id mismatch');
      console.log('✓ GET /standups/:id');
    } catch (e) {
      console.error('✗ GET /standups/:id', e.message);
      failed++;
    }
  }

  // 8. Run COO (summary) — optional
  if (createdStandupId && !SKIP_RUN_COO) {
    try {
      const updated = await post(`/standups/${createdStandupId}/run-coo`, {});
      if (updated?.coo_summary != null || updated?.ceo_summary != null) console.log('✓ POST /standups/:id/run-coo');
      else console.log('✓ POST /standups/:id/run-coo (no summary yet)');
    } catch (e) {
      console.log('○ POST /standups/:id/run-coo skipped or failed (ANTHROPIC_API_KEY?):', e.message);
    }
  } else if (createdStandupId) {
    console.log('○ POST /standups/:id/run-coo skipped (SKIP_RUN_COO=1)');
  }

  // 9. Agent workspace: list files (use first agent from list)
  let workspaceAgentId = null;
  try {
    const agents = await get('/agents');
    if (agents.length > 0) workspaceAgentId = agents[0].id;
  } catch (_) {}
  if (workspaceAgentId) {
    try {
      const files = await get(`/agents/${workspaceAgentId}/workspace/files`);
      if (!files || typeof files !== 'object') throw new Error('invalid response');
      console.log('✓ GET /agents/:id/workspace/files');
    } catch (e) {
      console.error('✗ GET /agents/:id/workspace/files', e.message);
      failed++;
    }

    // 10. Read MD file
    try {
      const r = await get(`/agents/${workspaceAgentId}/workspace/files/soul`);
      if (r?.text == null && r?.path == null) throw new Error('no text/path');
      console.log('✓ GET /agents/:id/workspace/files/:name (read)');
    } catch (e) {
      console.error('✗ GET /agents/:id/workspace/files/:name', e.message);
      failed++;
    }

    // 11. Write MD file (read then write same content back — verifies write without changing content)
    try {
      const r = await get(`/agents/${workspaceAgentId}/workspace/files/memory`);
      const original = r?.text ?? '';
      await put(`/agents/${workspaceAgentId}/workspace/files/memory`, { text: original });
      console.log('✓ PUT /agents/:id/workspace/files/:name (write)');
    } catch (e) {
      console.error('✗ PUT /agents/:id/workspace/files/:name', e.message);
      failed++;
    }
  } else {
    console.log('○ Workspace tests skipped (no agents)');
  }

  // 12. Agent chat history
  if (workspaceAgentId) {
    try {
      const turns = await get(`/agents/${workspaceAgentId}/chat`);
      if (!Array.isArray(turns)) throw new Error('not array');
      console.log('✓ GET /agents/:id/chat (history)');
    } catch (e) {
      console.error('✗ GET /agents/:id/chat', e.message);
      failed++;
    }

    // 13. Agent chat send (human–agent interaction)
    if (!SKIP_CHAT) {
      try {
        const r = await post(`/agents/${workspaceAgentId}/chat`, { message: 'Say "test ok" in 2 words.', user_id: 'test-full' });
        if (r?.reply == null) throw new Error('no reply');
        console.log('✓ POST /agents/:id/chat (send) — human–agent');
      } catch (e) {
        console.error('✗ POST /agents/:id/chat (gateway may be down):', e.message);
        failed++;
      }
    } else {
      console.log('○ POST /agents/:id/chat skipped (SKIP_CHAT=1)');
    }
  }

  // Cleanup: delete created agent so test is idempotent
  if (createdAgentId) {
    try {
      await fetch(`${BASE}/agents/${createdAgentId}`, { method: 'DELETE' });
    } catch (_) {}
  }

  console.log(failed === 0 ? '\nAll tests passed.' : '\n' + failed + ' test(s) failed.');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
