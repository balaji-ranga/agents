/**
 * Run test: Standup (topics for LinkedIn "AI for Finance") → COO messages TechResearcher →
 * TechResearcher returns topics → COO summarizes for CEO Bala.
 * Run from backend: node scripts/run-standup-research-test.js
 * Prereq: Backend and OpenClaw gateway running; OPENAI_API_KEY set for COO summary.
 */
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3001';

async function request(method, path, body = null) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${t}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function main() {
  const agents = await request('GET', '/agents');
  const coo = agents.find((a) => a.is_coo);
  const tech = agents.find((a) => a.id === 'techresearcher');
  if (!coo || !tech) {
    console.error('COO or TechResearcher missing. Run seed-all or ensure-techresearcher.');
    process.exit(1);
  }

  console.log('1. Create standup with topic: AI for Finance industry (LinkedIn research).');
  const standup = await request('POST', '/standups', {
    scheduled_at: new Date().toISOString(),
    status: 'scheduled',
  });
  const standupId = standup.id;
  console.log('   Standup id:', standupId);

  console.log('2. Add standup response: topics for research for LinkedIn "AI for Finance industry".');
  await request('POST', `/standups/${standupId}/responses`, {
    agent_id: tech.id,
    content: 'Topics for research for publish to LinkedIn: "AI for Finance industry". Request: research and come back with concrete angles and talking points.',
  });

  console.log('3. Run COO summarization on standup.');
  const updated = await request('POST', `/standups/${standupId}/run-coo`, {});
  console.log('   COO summary (excerpt):', (updated.coo_summary || '').slice(0, 200) + '...');
  console.log('   CEO summary (excerpt):', (updated.ceo_summary || '').slice(0, 200) + '...');

  console.log('4. COO messages TechResearcher to do research and come back with topics.');
  const fromAgentRes = await request('POST', `/agents/techresearcher/chat/from-agent`, {
    from_agent_id: coo.id,
    message: 'From our standup we have a request to research and prepare topics for a LinkedIn post on "AI for Finance industry". Please do the research and come back with 3–5 concrete angles or talking points we can use for the post.',
  });
  console.log('   TechResearcher reply (excerpt):', (fromAgentRes.reply || '').slice(0, 300) + '...');

  console.log('5. Add TechResearcher reply to standup and run COO again for CEO review.');
  await request('POST', `/standups/${standupId}/responses`, {
    agent_id: tech.id,
    content: `Research follow-up: ${fromAgentRes.reply || '(no reply)'}`,
  });
  const final = await request('POST', `/standups/${standupId}/run-coo`, {});
  console.log('   Final COO summary (excerpt):', (final.coo_summary || '').slice(0, 250) + '...');
  console.log('   Final CEO summary for Bala (excerpt):', (final.ceo_summary || '').slice(0, 250) + '...');

  console.log('\nDone. Standup id', standupId, '— view in Dashboard.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
