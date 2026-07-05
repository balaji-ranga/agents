/**
 * Test multi-intent COO delegation: each agent gets a redacted, context-specific message only.
 * Run backend with DEBUG_INTENT=1 to print prompts and model response:
 *   set DEBUG_INTENT=1 && node src/index.js
 * Then: node scripts/test-multi-intent.js
 * Prereq: Backend (3001) running.
 */
const API = process.env.API_BASE || 'http://127.0.0.1:3001';
const PROMPT =
  'Create an indian cuisine with recipie &image also i need a deep tech research on space science';

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
  console.log('Multi-intent delegation test');
  console.log('Prompt:', PROMPT);
  console.log('Expected: TechResearcher gets only research/space message; SocialAssistant gets only cuisine/recipe/image message.\n');

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

  console.log('3. Send multi-intent message to COO…');
  const res = await req('POST', `/api/standups/${id}/messages`, { content: PROMPT });
  const cooReply = res.coo_reply || '';

  console.log('   COO reply:', cooReply);

  let intentDebug = res.intent_debug;
  if (!intentDebug) {
    try {
      intentDebug = await req('GET', `${API}/api/debug/intent-last`);
    } catch (_) {}
  }
  if (intentDebug) {
    console.log('\n--- INTENT CLASSIFIER INPUT (system prompt) ---\n' + (intentDebug.systemPrompt || '') + '\n--- END SYSTEM PROMPT ---\n');
    console.log('--- INTENT CLASSIFIER INPUT (user message to model) ---\n' + (intentDebug.userMessage || '') + '\n--- END USER MESSAGE ---\n');
    if (intentDebug.modelRawResponse != null) console.log('--- INTENT CLASSIFIER OUTPUT (model raw response) ---\n' + intentDebug.modelRawResponse + '\n--- END MODEL RESPONSE ---\n');
    if (intentDebug.finalMapping != null) console.log('--- INTENT CLASSIFIER OUTPUT (final mapping agent_id -> message) ---\n' + JSON.stringify(intentDebug.finalMapping, null, 2) + '\n--- END FINAL MAPPING ---\n');
    if (intentDebug.error) console.log('--- INTENT ERROR ---', intentDebug.error, '\n');
  }

  if (!/I've asked .+ to look into this/i.test(cooReply)) {
    console.log('\n✗ FAIL: No delegation. COO replied directly.');
    process.exit(1);
  }

  console.log('4. Fetch delegation tasks (per-agent prompts)…');
  const standupWithTasks = await req('GET', `/api/standups/${id}?delegation_tasks=1`);
  const tasks = standupWithTasks.delegation_tasks || [];
  const request_id = standupWithTasks.delegation_request_id;
  if (!tasks || tasks.length === 0) {
    console.log('   No tasks found.');
    console.log('\n✗ FAIL: No delegation tasks created.');
    process.exit(1);
  }

  console.log('   Request id:', request_id);
  for (const t of tasks) {
    const p = t.prompt || '';
    const excerpt = p.slice(0, 180).replace(/\s+/g, ' ');
    console.log('   -', t.to_agent_id, ':', excerpt + (p.length > 180 ? '…' : ''));
  }

  const techTask = tasks.find((t) => t.to_agent_id === 'techresearcher');
  const socialTask = tasks.find((t) => t.to_agent_id === 'socialasstant');
  const techPrompt = (techTask?.prompt || '').toLowerCase();
  const socialPrompt = (socialTask?.prompt || '').toLowerCase();

  const techHasResearch = /space|research|science|tech/.test(techPrompt);
  const techHasCuisine = /cuisine|recipe|indian|image/.test(techPrompt);
  const socialHasCuisine = /cuisine|recipe|indian|image/.test(socialPrompt);
  const socialHasResearch = /space|research|science/.test(socialPrompt);

  let pass = true;
  if (!techTask || !socialTask) {
    console.log('\n✗ FAIL: Missing task for TechResearcher or SocialAssistant.');
    pass = false;
  }
  if (techTask && !techHasResearch) {
    console.log('\n✗ FAIL: TechResearcher task should contain research/space/science.');
    pass = false;
  }
  if (techTask && techHasCuisine) {
    console.log('\n✗ FAIL: TechResearcher task should NOT contain cuisine/recipe (redacted for research only).');
    pass = false;
  }
  if (socialTask && !socialHasCuisine) {
    console.log('\n✗ FAIL: SocialAssistant task should contain cuisine/recipe/image.');
    pass = false;
  }
  if (socialTask && socialHasResearch) {
    console.log('\n✗ FAIL: SocialAssistant task should NOT contain space/research (redacted for cuisine only).');
    pass = false;
  }

  if (pass) {
    console.log('\n✓ PASS: Multi-intent split correctly. TechResearcher got research-only message; SocialAssistant got cuisine-only message.');
  } else {
    process.exit(1);
  }

  console.log('\nStandup', id, '— open Dashboard and select this standup. Backend logs show intent prompts and model response if DEBUG_INTENT=1.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
