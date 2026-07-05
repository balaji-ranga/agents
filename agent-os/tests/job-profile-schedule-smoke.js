/**
 * Smoke: profile deactivate + workflow schedule (hourly/daily/weekly/manual).
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import {
  normalizeDiscoverySchedule,
  isScheduleDue,
  scheduleIntervalMs,
} from '../backend/src/services/job-applicant-schedule.js';
import { runPipelineTick, stopPipeline, startPipeline, getPipelineStatus } from '../backend/src/services/job-applicant-pipeline.js';

initDb();

const profile = createJobSearchProfileService(getDb);
const CEO = `schedule-smoke-${Date.now()}`;
const PID = `sched-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('✓', msg);
}

// Schedule normalization
assert(normalizeDiscoverySchedule('hourly') === 'hourly', 'hourly');
assert(normalizeDiscoverySchedule('every day') === 'daily', 'every day → daily');
assert(normalizeDiscoverySchedule('weekly') === 'weekly', 'weekly');
assert(normalizeDiscoverySchedule('pause') === 'manual', 'pause → manual');
assert(scheduleIntervalMs('hourly') === 3600000, 'hourly interval');

const hourAgo = new Date(Date.now() - 3700 * 1000).toISOString();
assert(isScheduleDue('hourly', hourAgo) === true, 'hourly due after 1h+');
assert(isScheduleDue('manual', hourAgo) === false, 'manual never due');

// Profile + deactivate
profile.createProfile(CEO, { profile_id: PID, display_name: 'Schedule test' });
profile.savePatch(CEO, PID, {
  locations: ['SG'],
  work_mode: 'remote',
  target_titles: ['Director'],
  sources: ['linkedin'],
  master_resume_path: 'C:\\Users\\balaj\\Downloads\\Resume-Balaji.pdf',
  linkedin_profile: 'https://www.linkedin.com/in/balajimuthukrishnan',
  fit_threshold: 70,
  approval_channel: 'kanban',
  submit_policy: 'fill_and_stop',
  honesty_ack: true,
  workflow_schedule: 'hourly',
});
const confirmed = profile.confirm(CEO, PID, true);
assert(confirmed.status === 'active', 'confirmed active');
assert(confirmed.workflow_schedule === 'hourly', 'workflow_schedule hourly on profile');

const deactivated = profile.deactivate(CEO, PID);
assert(deactivated.status === 'inactive', 'deactivated → inactive');
assert(profile.assertActive(CEO, PID).active === false, 'assertActive fails when inactive');

// Pipeline respects inactive
stopPipeline();
startPipeline(CEO); // should fail - no active profile
const startFail = startPipeline(CEO);
assert(startFail.ok === false, 'startPipeline fails without active profile');

// Reactivate
profile.confirm(CEO, PID, true);
assert(profile.getProfile(CEO, PID).status === 'active', 'reactivate via confirm');

const started = startPipeline(CEO);
assert(started.ok === true, 'startPipeline after reactivate');

const tick = runPipelineTick(CEO, PID);
assert(tick.ran === true, 'pipeline tick runs for active profile');
assert(tick.results?.schedule === 'hourly', 'tick reports hourly schedule');

const status = getPipelineStatus(CEO);
assert(status.workflow_schedule === 'hourly', 'pipeline status includes schedule');

console.log('\nOK — schedule + deactivate smoke passed\n');
