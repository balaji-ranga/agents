/**
 * Smoke test: health, agents list, standups list.
 * Run with: node tests/api-smoke.js
 * Prereq: Backend running at http://127.0.0.1:3001 (or set BASE_URL).
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';

async function run() {
  let failed = 0;
  const get = async (path) => {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  };
  try {
    const health = await get('/health');
    if (health?.status !== 'ok') throw new Error('health status not ok');
    console.log('GET /health ok');
  } catch (e) {
    console.error('GET /health failed:', e.message);
    failed++;
  }
  try {
    const agents = await get('/agents');
    if (!Array.isArray(agents)) throw new Error('agents not array');
    console.log('GET /agents ok', agents.length, 'agents');
  } catch (e) {
    console.error('GET /agents failed:', e.message);
    failed++;
  }
  try {
    const standups = await get('/standups');
    if (!Array.isArray(standups)) throw new Error('standups not array');
    console.log('GET /standups ok', standups.length, 'standups');
  } catch (e) {
    console.error('GET /standups failed:', e.message);
    failed++;
  }
  // Optional: test content-tools summarize-url (set TOOLS_TEST_URL to an HTTPS URL)
  const testUrl = process.env.TOOLS_TEST_URL;
  if (testUrl) {
    try {
      const res = await fetch(`${BASE}/api/tools/summarize-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: testUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data.error && !data.summary)) throw new Error(data.error || res.statusText);
      if (!data.summary || typeof data.summary !== 'string') throw new Error('summary missing');
      console.log('POST /api/tools/summarize-url ok');
    } catch (e) {
      console.error('POST /api/tools/summarize-url failed:', e.message);
      failed++;
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
