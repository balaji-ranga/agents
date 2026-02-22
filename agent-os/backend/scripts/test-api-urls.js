/**
 * Test all API URLs used by the frontend. Run: node scripts/test-api-urls.js
 * Uses BASE_URL env or http://127.0.0.1:3001 (test both / and /api prefixes).
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';

async function req(method, url, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function test(name, method, path, body, expectStatus = 200) {
  return req(method, `${BASE}${path}`, body).then(({ status, ok, data }) => {
    const pass = status === expectStatus || (expectStatus === '2xx' && status >= 200 && status < 300);
    const err = data?.error || (data && typeof data === 'object' && !data.status ? null : null);
    console.log(pass ? 'OK' : 'FAIL', method.padEnd(6), path.padEnd(45), status, err ? `- ${err}` : '');
    return pass;
  }).catch((e) => {
    console.log('FAIL', method.padEnd(6), path.padEnd(45), 'ERR', e.message);
    return false;
  });
}

async function main() {
  console.log('Testing API at', BASE, '\n');

  // Check backend is reachable
  try {
    const r = await fetch(BASE + '/health', { method: 'GET' });
    if (!r.ok) throw new Error('Health returned ' + r.status);
  } catch (e) {
    console.log('Backend not reachable at', BASE);
    console.log('Start it with: cd backend && node src/index.js\n');
    process.exit(1);
  }

  const results = [];

  // Health (root and /api)
  results.push(await test('health', 'GET', '/health', null));
  results.push(await test('health /api', 'GET', '/api/health', null));

  // Agents
  results.push(await test('agents list', 'GET', '/agents', null));
  results.push(await test('agents list /api', 'GET', '/api/agents', null));
  results.push(await test('agent get (may 404)', 'GET', '/agents/__test_id__', null, 404));

  // Standups
  results.push(await test('standups list', 'GET', '/standups', null));
  results.push(await test('standups list /api', 'GET', '/api/standups', null));
  results.push(await test('standups list limit', 'GET', '/api/standups?limit=5', null));
  results.push(await test('standup get (may 404)', 'GET', '/standups/999999', null, 404));
  const createRes = await req('POST', `${BASE}/api/standups`, { scheduled_at: new Date().toISOString(), status: 'scheduled' });
  const createdOk = createRes.status === 201 && createRes.data?.id;
  results.push(createdOk);
  console.log(createdOk ? 'OK' : 'FAIL', 'POST  ', '/api/standups (create)'.padEnd(45), createRes.status, createRes.data?.error || '');

  const standupId = createRes.data?.id || 1;
  results.push(await test('standup messages', 'GET', `/api/standups/${standupId}/messages`, null));
  results.push(await test('standup responses', 'GET', `/api/standups/${standupId}/responses`, null));

  // Cron
  results.push(await test('cron process-delegations', 'POST', '/api/cron/process-delegations', {}, 200));
  results.push(await test('cron process-delegations (root)', 'POST', '/cron/process-delegations', {}, 200));
  results.push(await test('cron run-standup', 'POST', '/api/cron/run-standup', {}, 200));

  // Workspace (may 500 if no workspace path)
  results.push(await test('workspace files', 'GET', '/api/workspace/files', null));

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log('\n' + passed + '/' + total + ' passed');
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
