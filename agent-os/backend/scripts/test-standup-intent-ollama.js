/**
 * Test standup chat with a simple prompt to verify intent classification (Ollama).
 * Usage: node scripts/test-standup-intent-ollama.js
 * Prereq: Backend at BASE_URL (default http://127.0.0.1:3001), COO agent in DB, COO workspace with AGENTS.md.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const PROMPT = process.argv[2] || 'do a deep research on Space tech';

async function main() {
  console.log('Base URL:', BASE);
  console.log('Prompt:', PROMPT);
  console.log('');

  // Create standup
  const createRes = await fetch(`${BASE}/api/standups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'test-ollama' }),
  });
  if (!createRes.ok) {
    console.error('Create standup failed:', createRes.status, await createRes.text());
    process.exit(1);
  }
  const standup = await createRes.json();
  const standupId = standup.id;
  console.log('Created standup id:', standupId);

  // Send message (triggers intent classification via Ollama)
  const msgRes = await fetch(`${BASE}/api/standups/${standupId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: PROMPT }),
  });
  const payload = await msgRes.json().catch(() => ({}));
  if (!msgRes.ok) {
    console.error('Send message failed:', msgRes.status, payload);
    process.exit(1);
  }

  console.log('COO reply:', payload.coo_reply || '(none)');
  if (payload.intent_debug) {
    console.log('\nIntent debug:');
    console.log('  error:', payload.intent_debug.error ?? 'none');
    console.log('  finalMapping:', JSON.stringify(payload.intent_debug.finalMapping ?? {}, null, 2));
    if (payload.intent_debug.modelRawResponse) {
      console.log('  modelRawResponse (first 300 chars):', String(payload.intent_debug.modelRawResponse).slice(0, 300));
    }
  } else {
    console.log('\nNo intent_debug in response (check DEBUG_INTENT=1 or last run at GET /api/debug/intent-last)');
  }

  // Assert: for "deep research on Space tech" only techresearcher should be tagged
  const mapping = payload.intent_debug?.finalMapping ?? {};
  const agentsTagged = Object.keys(mapping);
  const onlyTechResearcher = agentsTagged.length === 1 && (agentsTagged[0] === 'techresearcher' || agentsTagged[0].toLowerCase() === 'techresearcher');
  if (onlyTechResearcher) {
    console.log('\nPASS: Only TechResearcher tagged for this research prompt.');
  } else {
    console.log('\nFAIL: Expected only techresearcher to be tagged, got:', agentsTagged);
    if (agentsTagged.length === 0 && payload.coo_reply?.includes('TechResearcher and ExpenseManager')) {
      console.log('Tip: Backend may be running old code. Restart it (node src/index.js) and run this test again.');
    }
    process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
