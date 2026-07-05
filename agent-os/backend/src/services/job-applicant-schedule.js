/**
 * Job search workflow schedule helpers.
 */
export const WORKFLOW_SCHEDULES = ['hourly', 'daily', 'weekly', 'manual'];

const ALIASES = {
  hour: 'hourly',
  hours: 'hourly',
  'every hour': 'hourly',
  '1h': 'hourly',
  day: 'daily',
  days: 'daily',
  'every day': 'daily',
  '24h': 'daily',
  week: 'weekly',
  weeks: 'weekly',
  'every week': 'weekly',
  '7d': 'weekly',
  off: 'manual',
  disabled: 'manual',
  none: 'manual',
  pause: 'manual',
  paused: 'manual',
};

/** Normalize workflow / discovery schedule from intake or agent input. */
export function normalizeDiscoverySchedule(v) {
  if (v == null || v === '') return 'daily';
  const s = String(v).trim().toLowerCase();
  if (WORKFLOW_SCHEDULES.includes(s)) return s;
  if (ALIASES[s]) return ALIASES[s];
  if (s.includes('hour')) return 'hourly';
  if (s.includes('week')) return 'weekly';
  if (s.includes('day')) return 'daily';
  if (s.includes('manual') || s.includes('pause')) return 'manual';
  return 'daily';
}

/** Milliseconds between automated workflow runs for a schedule. null = never auto-run. */
export function scheduleIntervalMs(schedule) {
  const s = normalizeDiscoverySchedule(schedule);
  if (s === 'manual') return null;
  if (s === 'hourly') return 60 * 60 * 1000;
  if (s === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/** True if enough time elapsed since lastRunIso for this schedule. */
export function isScheduleDue(schedule, lastRunIso) {
  const interval = scheduleIntervalMs(schedule);
  if (interval == null) return false;
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= interval;
}

export function scheduleLabel(schedule) {
  const s = normalizeDiscoverySchedule(schedule);
  return {
    hourly: 'Every hour',
    daily: 'Daily',
    weekly: 'Weekly',
    manual: 'Manual only',
  }[s];
}
