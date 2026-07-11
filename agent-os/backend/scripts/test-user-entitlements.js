/**
 * E2E entitlement test: resources created as Shared User must not appear for Bala CEO.
 * Run: node backend/scripts/test-user-entitlements.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import { createSession } from '../src/services/auth/session.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import * as openclaw from '../src/gateway/openclaw.js';
import { registerOpenClawSessionOwner } from '../src/services/tool-owner-scope.js';

initDb();

const BASE = (process.env.AGENT_OS_PUBLIC_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const API = `${BASE}/api`;
const STAMP = Date.now().toString(36);
const SHARED_USER_ID = process.env.ENTITLEMENT_SHARED_USER_ID || 'ceo-shared-mrg5chde-422d97';
const BALA_USER_ID = getBalaCeoAuthId();
const ADMIN_USER_ID = process.env.ENTITLEMENT_ADMIN_ID || 'admin-admin-ffa771';

const IDS = {
  agent: `entitlement-agent-${STAMP}`,
  mcp: `entitlement-mcp-${STAMP}`,
  a2a: `entitlement-a2a-${STAMP}`,
  script: `entitlement-script-${STAMP}`,
};

const results = [];

function pass(label) {
  results.push({ ok: true, label });
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  results.push({ ok: false, label, detail });
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function hasId(items, id, key = 'id') {
  return (items || []).some((x) => x[key] === id);
}

async function fetchLists(token) {
  const [agents, workflows, mcps, a2a, scripts, mcpsWf, a2aWf, scriptsWf] = await Promise.all([
    api(token, 'GET', '/agents'),
    api(token, 'GET', '/agent-workflows'),
    api(token, 'GET', '/integrations/mcp'),
    api(token, 'GET', '/integrations/external-agents'),
    api(token, 'GET', '/integrations/custom-scripts'),
    api(token, 'GET', '/integrations/mcp?for_workflow=1'),
    api(token, 'GET', '/integrations/external-agents?for_workflow=1'),
    api(token, 'GET', '/integrations/custom-scripts?for_workflow=1'),
  ]);
  return {
    agents: agents || [],
    workflows: workflows.workflows || [],
    mcps: mcps.servers || [],
    a2a: a2a.agents || [],
    scripts: scripts.scripts || [],
    mcpsWf: mcpsWf.servers || [],
    a2aWf: a2aWf.agents || [],
    scriptsWf: scriptsWf.scripts || [],
  };
}

function assertVisible(lists, ids, workflowId, userLabel, shouldExist = true) {
  const checks = [
    ['agent workspace agent', lists.agents, ids.agent],
    ['workflow list', lists.workflows, workflowId],
    ['MCP registry', lists.mcps, ids.mcp],
    ['A2A registry', lists.a2a, ids.a2a],
    ['custom script registry', lists.scripts, ids.script],
    ['workflow editor MCP dropdown', lists.mcpsWf, ids.mcp],
    ['workflow editor A2A dropdown', lists.a2aWf, ids.a2a],
    ['workflow editor script dropdown', lists.scriptsWf, ids.script],
    ['workflow editor agent list', lists.agents, ids.agent],
  ];
  for (const [label, items, id] of checks) {
    if (!id) continue;
    const found = hasId(items, id);
    if (shouldExist && found) pass(`${userLabel}: ${label} includes ${id}`);
    else if (shouldExist && !found) fail(`${userLabel}: ${label} missing ${id}`);
    else if (!shouldExist && found) fail(`${userLabel}: ${label} should NOT include ${id}`);
    else if (!shouldExist && !found) pass(`${userLabel}: ${label} correctly excludes ${id}`);
  }
}

async function testCooWorkflowList(sharedUserId, workflowId, shouldInclude) {
  const coo = getDb().prepare('SELECT id, openclaw_agent_id FROM agents WHERE is_coo = 1 LIMIT 1').get();
  if (!coo) {
    fail('COO workflow tool', 'no COO agent');
    return;
  }
  const openclawId = coo.openclaw_agent_id || coo.id;
  const sessionUser = openclaw.sessionUserFor(coo.id, sharedUserId);
  const sessionKey = openclaw.sessionKeyFor(openclawId, sessionUser);
  registerOpenClawSessionOwner(sessionKey, sharedUserId);

  const toolsKey = process.env.TOOLS_API_KEY || '';
  if (!toolsKey) {
    fail('COO workflow tool', 'TOOLS_API_KEY not set in environment');
    return;
  }
  const headers = {
    'Content-Type': 'application/json',
    'x-openclaw-agent-id': coo.id,
    'x-openclaw-session-key': sessionKey,
  };
  if (toolsKey) headers.Authorization = `Bearer ${toolsKey}`;

  const res = await fetch(`${API}/tools/agent-workflow-list`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail('COO agent_workflow_list', data.error || res.statusText);
    return;
  }
  if (data.ceo_user_id !== sharedUserId) {
    fail('COO agent_workflow_list owner', `expected ${sharedUserId}, got ${data.ceo_user_id}`);
    return;
  }
  const found = (data.workflows || []).some((w) => w.id === workflowId);
  if (shouldInclude && found) pass(`COO tool lists shared workflow ${workflowId} for ${sharedUserId}`);
  else if (shouldInclude && !found) fail(`COO tool missing shared workflow ${workflowId}`);
  else if (!shouldInclude && found) fail(`COO tool leaked shared workflow ${workflowId} to wrong context`);
  else pass('COO tool owner scoping OK');
}

async function testSpoofedCeoUserIdRejected(sharedUserId, balaUserId) {
  const coo = getDb().prepare('SELECT id, openclaw_agent_id FROM agents WHERE is_coo = 1 LIMIT 1').get();
  const toolsKey = process.env.TOOLS_API_KEY || '';
  if (!coo || !toolsKey) return;

  const openclawId = coo.openclaw_agent_id || coo.id;
  const sessionUser = openclaw.sessionUserFor(coo.id, sharedUserId);
  const sessionKey = openclaw.sessionKeyFor(openclawId, sessionUser);
  registerOpenClawSessionOwner(sessionKey, sharedUserId);

  const res = await fetch(`${API}/tools/agent-workflow-list`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${toolsKey}`,
      'x-openclaw-agent-id': coo.id,
      'x-openclaw-session-key': sessionKey,
    },
    body: JSON.stringify({ ceo_user_id: balaUserId, all: true }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail('Spoofed ceo_user_id rejected', data.error || res.statusText);
    return;
  }
  if (data.ceo_user_id === sharedUserId) pass('Spoofed ceo_user_id ignored; session owner used');
  else fail('Spoofed ceo_user_id', `got owner ${data.ceo_user_id}`);
}

async function main() {
  console.log('Entitlement E2E test');
  console.log(`  Shared user: ${SHARED_USER_ID}`);
  console.log(`  Bala CEO:    ${BALA_USER_ID}`);
  console.log(`  API:         ${API}\n`);

  const sharedToken = createSession(SHARED_USER_ID).token;
  const balaToken = createSession(BALA_USER_ID).token;
  const adminToken = createSession(ADMIN_USER_ID).token;

  console.log('1. Create custom agent (admin) + grant to Shared User only');
  await api(adminToken, 'POST', '/admin/agents/custom', {
    id: IDS.agent,
    name: `Entitlement Agent ${STAMP}`,
    role: 'Test agent for entitlement isolation',
    owner_user_id: SHARED_USER_ID,
  });
  await api(adminToken, 'POST', `/admin/users/${SHARED_USER_ID}/agents/${IDS.agent}/enable`, {});

  console.log('2. Shared User creates MCP, A2A, custom script, workflow');
  await api(sharedToken, 'POST', '/integrations/mcp', {
    id: IDS.mcp,
    name: `Entitlement MCP ${STAMP}`,
    url: 'http://127.0.0.1:19999/mcp',
    transport: 'streamable_http',
    description: 'Entitlement test MCP — shared user only',
  });
  await api(sharedToken, 'PATCH', `/integrations/mcp/${IDS.mcp}`, { status: 'healthy' });

  await api(sharedToken, 'POST', '/integrations/external-agents', {
    id: IDS.a2a,
    name: `Entitlement A2A ${STAMP}`,
    card_url: 'https://example.com/entitlement-card.json',
    endpoint_url: 'https://example.com/entitlement-a2a',
    description: 'Entitlement test external agent',
  });
  await api(sharedToken, 'PATCH', `/integrations/external-agents/${IDS.a2a}`, { status: 'healthy' });

  let scriptCreated = false;
  try {
    await api(sharedToken, 'POST', '/integrations/custom-scripts', {
      id: IDS.script,
      name: `Entitlement Script ${STAMP}`,
      language: 'javascript',
      description: 'Returns ok',
      source: 'export default async function main() { return { ok: true, test: "entitlement" }; }',
    });
    scriptCreated = true;
  } catch (e) {
    console.warn(`  custom script API create failed (${e.message}); marking approved in DB for test`);
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO custom_scripts (
        id, name, description, language, runtime_profile, source,
        scan_result_json, scan_status, risk_level, status,
        owner_user_id, owner_role, is_platform, created_at, updated_at
      ) VALUES (?, ?, ?, 'javascript', 'restricted', ?, '{}', 'approved', 'low', 'approved', ?, 'ceo', 0, datetime('now'), datetime('now'))`
    ).run(
      IDS.script,
      `Entitlement Script ${STAMP}`,
      'test',
      'export default async function main() { return { ok: true }; }',
      SHARED_USER_ID
    );
    scriptCreated = true;
  }
  if (!scriptCreated) throw new Error('Could not create custom script');

  const db = getDb();
  const scriptRow = db.prepare('SELECT status, scan_status FROM custom_scripts WHERE id = ?').get(IDS.script);
  if (scriptRow && (scriptRow.status !== 'approved' || scriptRow.scan_status !== 'approved')) {
    db.prepare(
      `UPDATE custom_scripts SET status = 'approved', scan_status = 'approved', risk_level = 'low' WHERE id = ?`
    ).run(IDS.script);
  }

  const wf = await api(sharedToken, 'POST', '/agent-workflows', {
    name: `Entitlement Workflow ${STAMP}`,
    description: 'Shared user entitlement test workflow',
    graph: {
      nodes: [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 0, y: 0 },
          data: { label: 'Start', task_type: 'trigger', task_config: { trigger_modes: ['manual'] } },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  });
  const workflowId = wf.id;
  await api(sharedToken, 'POST', `/agent-workflows/${encodeURIComponent(workflowId)}/publish`, {});

  console.log('\n3. Verify Shared User sees all created resources');
  const sharedLists = await fetchLists(sharedToken);
  assertVisible(sharedLists, IDS, workflowId, 'Shared User', true);

  console.log('\n4. Verify Bala CEO does NOT see Shared User resources');
  const balaLists = await fetchLists(balaToken);
  assertVisible(balaLists, IDS, workflowId, 'Bala CEO', false);

  console.log('\n5. COO workflow list tool scoped to Shared User session');
  await testCooWorkflowList(SHARED_USER_ID, workflowId, true);

  console.log('\n6. COO tool must not return shared workflow when scoped to Bala');
  await testCooWorkflowList(BALA_USER_ID, workflowId, false);

  console.log('\n7. Spoofed ceo_user_id in body is ignored (session owner wins)');
  await testSpoofedCeoUserIdRejected(SHARED_USER_ID, BALA_USER_ID);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error('\nFailed checks:');
    for (const f of failed) console.error(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('\nAll entitlement checks passed.');
  console.log('\nCreated resource IDs (for manual UI verification):');
  console.log(JSON.stringify({ ...IDS, workflowId, sharedUserId: SHARED_USER_ID }, null, 2));
}

main().catch((e) => {
  console.error('\nFatal:', e.message);
  if (e.data) console.error(JSON.stringify(e.data, null, 2));
  process.exit(1);
});
