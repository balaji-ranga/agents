/**
 * Repair stale schedule_cron on workflows where schedule mode was removed.
 * Usage: node scripts/repair-agent-workflow-triggers.js
 */
import { initDb, getDb } from '../src/db/schema.js';
import { repairStaleScheduleCrons, updateTriggers, getDefinition } from '../src/services/agent-workflow-store.js';
import { notifySchedulerConfigurationChanged, stopScheduleForDefinition } from '../src/services/agent-workflow-scheduler.js';

initDb();

const actor = { id: 'repair-script', name: 'Repair Script', type: 'system' };
const repaired = repairStaleScheduleCrons();
console.log(`Cleared stale schedule_cron on ${repaired} workflow(s)`);

const rows = getDb()
  .prepare(
    `SELECT id, owner_user_id, trigger_modes, schedule_cron, chat_trigger_phrase
     FROM agent_workflow_definitions WHERE id = 'sample-job-discovery-email'`
  )
  .all();

for (const row of rows) {
  stopScheduleForDefinition(row.id);
  const modes = (row.trigger_modes || 'manual').split(',').map((s) => s.trim()).filter(Boolean);
  updateTriggers(
    row.id,
    row.owner_user_id,
    {
      trigger_modes: modes,
      schedule_cron: row.schedule_cron,
      chat_trigger_phrase: row.chat_trigger_phrase,
    },
    actor
  );
  const def = getDefinition(row.id, row.owner_user_id);
  console.log(`  ${row.id}: modes=${def.trigger_modes.join(',')} cron="${def.schedule_cron}" paused=${def.paused}`);
}

notifySchedulerConfigurationChanged();
console.log('Scheduler DB config repaired (restart backend to pick up if running).');
