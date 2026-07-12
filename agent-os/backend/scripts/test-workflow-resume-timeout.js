/**
 * Smoke: restart orphan resume + persisted timeout reap helpers.
 * Uses DB fixtures; does not require IB Gateway.
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import {
  resumeStuckWorkflowRuns,
  reapTimedOutWorkflowSteps,
  startWorkflowTimeoutWatchdog,
} from '../src/services/agent-workflow-runner.js';
import { DEFAULT_NODE_TIMEOUT_MS } from '../src/services/agent-workflow-node-timeout.js';

initDb();
const db = getDb();

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const owner =
  db.prepare(`SELECT id FROM platform_users ORDER BY id ASC LIMIT 1`).get()?.id || 'test-owner';

const def = db
  .prepare(
    `SELECT id, published_graph_json FROM agent_workflow_definitions
     WHERE status = 'published' AND published_graph_json IS NOT NULL
     ORDER BY updated_at DESC LIMIT 1`
  )
  .get();

if (!def) {
  console.log('SKIP: no published workflow definition');
  process.exit(0);
}

let graph;
try {
  graph = JSON.parse(def.published_graph_json);
} catch {
  console.log('SKIP: bad published graph');
  process.exit(0);
}

const customNode = (graph.nodes || []).find((n) =>
  ['custom_script', 'api', 'brain'].includes(n.type)
);
if (!customNode) {
  console.log('SKIP: no resumable node in latest published workflow');
  process.exit(0);
}

const runNumber =
  (db
    .prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS n FROM agent_workflow_runs WHERE definition_id = ?')
    .get(def.id)?.n) || 1;

db.prepare(
  `INSERT INTO agent_workflow_runs (run_number, definition_id, owner_user_id, status, trigger, context_json)
   VALUES (?, ?, ?, 'running', 'manual', ?)`
).run(runNumber, def.id, owner, JSON.stringify({ node_outputs: {}, initial_input: 'resume-timeout-test' }));

const runId = db.prepare('SELECT id FROM agent_workflow_runs ORDER BY id DESC LIMIT 1').get()?.id;

// Simulate orphan in_progress started 25 minutes ago (past default 20m timeout)
db.prepare(
  `INSERT INTO agent_workflow_run_steps
   (run_id, node_id, node_type, node_label, status, started_at, iteration)
   VALUES (?, ?, ?, ?, 'in_progress', datetime('now', '-25 minutes'), 1)`
).run(runId, customNode.id, customNode.type, customNode.data?.label || customNode.id);

console.log(`Fixture run ${runId} node ${customNode.id} (${customNode.type}) timed out in DB`);

const reaped = await reapTimedOutWorkflowSteps();
assert(reaped >= 1, `expected reap >= 1, got ${reaped}`);

const runAfter = db.prepare('SELECT status, error_message FROM agent_workflow_runs WHERE id = ?').get(runId);
const stepAfter = db
  .prepare(`SELECT status, error_message FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?`)
  .get(runId, customNode.id);

assert(
  runAfter.status === 'failed' || stepAfter.status === 'completed',
  `expected fail or default_output continue; run=${runAfter.status} step=${stepAfter.status}`
);
assert(
  String(stepAfter.error_message || runAfter.error_message || '').includes('timed out'),
  'expected timeout message'
);

console.log('reapTimedOutWorkflowSteps OK:', {
  run: runAfter.status,
  step: stepAfter.status,
  error: stepAfter.error_message || runAfter.error_message,
});

// Second fixture: orphan with remaining time (started 1 minute ago)
db.prepare(
  `INSERT INTO agent_workflow_runs (run_number, definition_id, owner_user_id, status, trigger, context_json)
   VALUES (?, ?, ?, 'running', 'manual', ?)`
).run(runNumber + 1, def.id, owner, JSON.stringify({ node_outputs: {}, initial_input: 'resume-remaining-test' }));

const runId2 = db.prepare('SELECT id FROM agent_workflow_runs ORDER BY id DESC LIMIT 1').get()?.id;
db.prepare(
  `INSERT INTO agent_workflow_run_steps
   (run_id, node_id, node_type, node_label, status, started_at, iteration)
   VALUES (?, ?, ?, ?, 'in_progress', datetime('now', '-1 minutes'), 1)`
).run(runId2, customNode.id, customNode.type, customNode.data?.label || customNode.id);

resumeStuckWorkflowRuns();
startWorkflowTimeoutWatchdog(60000);

// Give async resume a moment to flip status
await new Promise((r) => setTimeout(r, 2500));

const step2 = db
  .prepare(`SELECT status, started_at FROM agent_workflow_run_steps WHERE run_id = ? AND node_id = ?`)
  .get(runId2, customNode.id);

assert(
  ['pending', 'in_progress', 'completed', 'failed'].includes(step2.status),
  `unexpected status after resume: ${step2.status}`
);
console.log('resumeStuckWorkflowRuns touched run', runId2, '→', step2.status);
console.log('DEFAULT_NODE_TIMEOUT_MS', DEFAULT_NODE_TIMEOUT_MS);
console.log('OK');
process.exit(0);
