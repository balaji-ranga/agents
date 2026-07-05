/**
 * Agent workflow scheduler — reads ONLY from central DB registry (agent_workflow_schedules).
 * One master tick per backend process; registry rebuilt on startup and trigger changes.
 */
import cron from 'node-cron';
import {
  listScheduledFromRegistry,
  getDefinition,
  isWorkflowTriggerable,
  isWorkflowInScheduleRegistry,
  repairStaleScheduleCrons,
  claimScheduleFire,
  syncWorkflowScheduleRegistry,
  listScheduleRegistryRows,
  removeWorkflowSchedule,
} from './agent-workflow-store.js';
import { startAgentWorkflowRun } from './agent-workflow-runner.js';

const MASTER_CRON = process.env.AGENT_WORKFLOW_SCHEDULER_CRON || '* * * * *';
let masterTask = null;

function minuteKey(d = new Date()) {
  return d.toISOString().slice(0, 16);
}

function cronFieldMatches(field, value) {
  const f = String(field ?? '').trim();
  if (f === '*') return true;
  if (f.startsWith('*/')) {
    const step = parseInt(f.slice(2), 10);
    return Number.isFinite(step) && step > 0 && value % step === 0;
  }
  if (f.includes('-')) {
    const [a, b] = f.split('-').map((x) => parseInt(x, 10));
    return value >= a && value <= b;
  }
  if (f.includes(',')) {
    return f.split(',').some((p) => parseInt(p, 10) === value);
  }
  const n = parseInt(f, 10);
  return Number.isFinite(n) && n === value;
}

export function isCronDue(expression, date = new Date()) {
  if (!expression || !cron.validate(expression)) return false;
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  const min = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  return (
    cronFieldMatches(minF, min) &&
    cronFieldMatches(hourF, hour) &&
    cronFieldMatches(domF, dom) &&
    cronFieldMatches(monF, mon) &&
    cronFieldMatches(dowF, dow)
  );
}

export async function tickScheduledWorkflows(now = new Date()) {
  repairStaleScheduleCrons();
  const defs = listScheduledFromRegistry();
  const mk = minuteKey(now);

  for (const def of defs) {
    const definitionId = def.id;
    if (!def.schedule_cron || !isCronDue(def.schedule_cron, now)) continue;

    const latest = getDefinition(definitionId, def.owner_user_id);
    if (!isWorkflowTriggerable(latest)) continue;
    if (!latest?.trigger_modes?.includes('schedule')) continue;
    if (!isWorkflowInScheduleRegistry(definitionId)) continue;
    if (!claimScheduleFire(definitionId, mk)) continue;

    try {
      console.log(`[agent-workflow-scheduler] Running scheduled workflow: ${latest.name} (${definitionId}) pid=${process.pid}`);
      await startAgentWorkflowRun(definitionId, latest.owner_user_id, {
        trigger: 'schedule',
        input: `Scheduled run at ${now.toISOString()}`,
        actor: { type: 'system', id: 'scheduler', name: 'Scheduler' },
      });
    } catch (e) {
      console.error(`[agent-workflow-scheduler] Failed ${definitionId}:`, e.message);
    }
  }
}

/** Remove workflow from central registry immediately (pause / manual-only). */
export function stopScheduleForDefinition(definitionId) {
  removeWorkflowSchedule(definitionId);
  return true;
}

export function refreshAgentWorkflowSchedules() {
  syncWorkflowScheduleRegistry();
  const rows = listScheduleRegistryRows();
  console.log(
    `[agent-workflow-scheduler] Registry synced — ${rows.length} row(s):`,
    rows.map((r) => `${r.definition_id} cron=${r.schedule_cron} paused=${r.paused}`).join(', ') || '(none)'
  );
}

export function notifySchedulerConfigurationChanged(definitionId = null) {
  syncWorkflowScheduleRegistry(definitionId || undefined);
}

export function getScheduleRegistrySnapshot() {
  return listScheduleRegistryRows();
}

export function initAgentWorkflowScheduler() {
  syncWorkflowScheduleRegistry();
  if (masterTask) return;
  if (!cron.validate(MASTER_CRON)) {
    console.warn(`[agent-workflow-scheduler] Invalid AGENT_WORKFLOW_SCHEDULER_CRON: ${MASTER_CRON}`);
    return;
  }
  masterTask = cron.schedule(MASTER_CRON, () => {
    tickScheduledWorkflows().catch((e) => console.error('[agent-workflow-scheduler] tick error:', e.message));
  });
  const rows = listScheduleRegistryRows();
  console.log(
    `[agent-workflow-scheduler] Master tick ${MASTER_CRON} pid=${process.pid} — registry:`,
    rows.length ? rows.map((r) => r.definition_id).join(', ') : '(empty)'
  );
}
