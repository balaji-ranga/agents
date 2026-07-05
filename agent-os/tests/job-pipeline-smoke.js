/**
 * Smoke test: job pipeline enqueue + handoff (no OpenClaw gateway).
 */
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import {
  ensurePipelineStandup,
  enqueuePipelineStage,
  maybeHandoffJobPipeline,
  getPipelineStatus,
  startPipeline,
} from '../backend/src/services/job-applicant-pipeline.js';

initDb();
const profile = createJobSearchProfileService(getDb);

const CEO = 'default';
const PROFILE = 'default';

profile.savePatch(CEO, PROFILE, {
  locations: ['Remote'],
  work_mode: 'remote',
  target_titles: ['Architect'],
  sources: ['linkedin'],
  master_resume_path: '1_foundations/me/Bala_resume_latest.pdf',
  fit_threshold: 70,
  approval_channel: 'kanban',
  submit_policy: 'fill_and_stop',
  honesty_ack: true,
  discovery_schedule: 'manual',
});
profile.confirm(CEO, PROFILE, true);

const standupId = ensurePipelineStandup();
console.log('standup', standupId);

const started = startPipeline(CEO);
console.log('start', started.skipped === false ? started.started?.stage : started);

const status = getPipelineStatus();
console.log('enabled', status.enabled, 'pending', status.pending_pipeline_tasks);

const db = getDb();
const pending = db
  .prepare('SELECT * FROM agent_delegation_tasks WHERE standup_id = ? ORDER BY id DESC LIMIT 1')
  .get(standupId);
console.log('delegation stage', pending?.prompt?.match(/\[job_pipeline:(\w+)\]/)?.[1]);

const completed = { ...pending, status: 'completed', response_content: 'done' };
const handoff = await maybeHandoffJobPipeline(completed);
console.log('handoff', handoff?.handoff);

console.log('OK');
