/**
 * Force-stop Job Discovery → Email: pause, manual-only triggers, clear registry, cancel runs.
 * Usage: node scripts/force-stop-job-discovery-email.js
 */
import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import {
  listScheduleRegistryRows,
  syncWorkflowScheduleRegistry,
  removeWorkflowSchedule,
} from '../src/services/agent-workflow-store.js';
import { pauseAllRuns } from '../src/services/agent-workflow-run-manager.js';
import { stopScheduleForDefinition } from '../src/services/agent-workflow-scheduler.js';

initDb();
const db = getDb();
const WF_ID = 'sample-job-discovery-email';
const actor = { id: 'force-stop', name: 'Force Stop Script', type: 'system' };

const row = db.prepare('SELECT owner_user_id FROM agent_workflow_definitions WHERE id = ?').get(WF_ID);
if (!row) {
  console.error('Workflow not found:', WF_ID);
  process.exit(1);
}
const ownerUserId = row.owner_user_id;

store.setPaused(WF_ID, ownerUserId, true, actor);
store.updateTriggers(
  WF_ID,
  ownerUserId,
  { trigger_modes: ['manual'], schedule_cron: '', chat_trigger_phrase: '' },
  actor
);
stopScheduleForDefinition(WF_ID);
removeWorkflowSchedule(WF_ID);
syncWorkflowScheduleRegistry();

const paused = pauseAllRuns(ownerUserId, { definitionId: WF_ID, actor });
console.log('Paused active runs:', paused.paused);

db.prepare('DELETE FROM agent_workflow_run_steps WHERE run_id IN (SELECT id FROM agent_workflow_runs WHERE definition_id = ?)').run(WF_ID);
const deleted = db.prepare('DELETE FROM agent_workflow_runs WHERE definition_id = ?').run(WF_ID);
console.log('Deleted runs:', deleted.changes);

const def = store.getDefinition(WF_ID, ownerUserId);
console.log('\nFinal state:');
console.log({
  paused: def.paused,
  trigger_modes: def.trigger_modes,
  schedule_cron: def.schedule_cron,
});
console.log('Schedule registry:', listScheduleRegistryRows());
