/**
 * Diagnose why Job Discovery → Email may still be running.
 */
import { initDb, getDb } from '../src/db/schema.js';
import { getDefinition, listScheduledFromRegistry, listScheduleRegistryRows } from '../src/services/agent-workflow-store.js';

initDb();
const db = getDb();
const WF_ID = 'sample-job-discovery-email';

console.log('=== Definition row ===');
const row = db.prepare('SELECT * FROM agent_workflow_definitions WHERE id = ?').get(WF_ID);
console.log(row ? {
  id: row.id,
  status: row.status,
  paused: row.paused,
  trigger_modes: row.trigger_modes,
  schedule_cron: row.schedule_cron,
  chat_trigger_phrase: row.chat_trigger_phrase,
} : 'NOT FOUND');

const def = row ? getDefinition(WF_ID, row.owner_user_id) : null;
if (def) {
  const trig = def.published_graph?.nodes?.find((n) => n.type === 'trigger') || def.draft_graph?.nodes?.find((n) => n.type === 'trigger');
  console.log('\n=== Trigger node in graph ===');
  console.log(trig?.data || 'no trigger node');
}

console.log('\n=== Central schedule registry ===');
console.log(listScheduleRegistryRows());
console.log('\n=== Active schedules (tick source) ===');
console.log(listScheduledFromRegistry().map((d) => ({ id: d.id, cron: d.schedule_cron, paused: d.paused })));

console.log('\n=== Recent runs (last 10) ===');
console.log(
  db
    .prepare(
      `SELECT id, run_number, trigger, status, started_at, completed_at
       FROM agent_workflow_runs WHERE definition_id = ? ORDER BY id DESC LIMIT 10`
    )
    .all(WF_ID)
);

console.log('\n=== Active runs ===');
console.log(
  db
    .prepare(
      `SELECT id, run_number, trigger, status, started_at FROM agent_workflow_runs
       WHERE definition_id = ? AND status IN ('running', 'pending')`
    )
    .all(WF_ID)
);

console.log('\n=== Pending agent_workflow delegations ===');
console.log(
  db
    .prepare(
      `SELECT id, status, created_at, substr(prompt, 1, 200) AS prompt
       FROM agent_delegation_tasks
       WHERE status IN ('pending', 'processing') AND prompt LIKE '%agent_workflow:${WF_ID}%'`
    )
    .all()
);

console.log('\n=== Recent kanban (agent workflow tags) ===');
console.log(
  db
    .prepare(
      `SELECT id, title, status, created_at FROM kanban_tasks
       WHERE description LIKE '%agent_workflow:${WF_ID}%' ORDER BY id DESC LIMIT 8`
    )
    .all()
);

console.log('\n=== Job pipeline delegations (separate system) ===');
console.log(
  db
    .prepare(
      `SELECT id, status, created_at, substr(prompt, 1, 120) AS prompt
       FROM agent_delegation_tasks
       WHERE status IN ('pending', 'processing') AND prompt LIKE '%job_pipeline%'
       ORDER BY id DESC LIMIT 5`
    )
    .all()
);
