/**
 * Job Applicant pipeline: scheduled agent-to-agent handoffs after profile is active.
 * Profile intake stays interactive (Job Discovery + CEO only).
 * Pipeline stages create Kanban tasks + delegation tasks → notifications via standups/notifications.
 */
import { getDb } from '../db/schema.js';
import { getDbForCeo } from '../db/request-db.js';
import { createJobSearchProfileService } from './job-search-profile.js';
import { createJobApplicationsService } from './job-applications.js';
import { getDefaultCeoUserId } from './job-applicant-ceo.js';
import {
  normalizeDiscoverySchedule,
  isScheduleDue,
  scheduleIntervalMs,
  scheduleLabel,
} from './job-applicant-schedule.js';
import { runPhase1SubmitCeoReview } from './job-applicant-ceo-review.js';
import { requiresJobApplication } from './job-applicant-workflow-goal.js';
import { getJobWorkflowTracker } from './job-workflow-tracker.js';
import { upsertWorkflowStageKanban, completePipelineKanbanForDelegation } from './kanban-workflow-stage.js';
import { assertDiscoveryBrowserReady, PortalLoginRequiredError, getBrowserAuthStatus } from './job-browser-auth.js';
import { formatDiscoverySearchUrlsForPrompt } from './portal-connect.js';
import {
  buildDiscoveryPaginationBlock,
  assessDiscoveryRun,
  parseDiscoveryRetry,
  DISCOVERY_RETRY_MAX,
} from './job-discovery-instructions.js';
import { harvestAndAppendJobs } from './job-discovery-harvest.js';
import { createJobApplicantSpreadsheetService } from './job-applicant-spreadsheet.js';

const PIPELINE_TAG = '[job_pipeline';
const STAGE_AGENT = {
  discovery: 'jobdiscovery',
  fitscorer: 'fitscorer',
  resumetailor: 'resumetailor',
  applicationagent: 'applicationagent',
};

const STAGE_NEXT = {
  discovery: 'fitscorer',
  fitscorer: 'resumetailor',
  resumetailor: null,
  applicationagent: null,
};

/** Strict order — discovery must finish before fit scoring, etc. */
export const PIPELINE_STAGE_ORDER = ['discovery', 'fitscorer', 'resumetailor', 'applicationagent'];

/** Job counts for pipeline routing (UI vs empty tracker). */
export function summarizeProfileJobs(jobsSvc, ceoUserId, profileId) {
  const all = jobsSvc.list({ ceo_user_id: ceoUserId, profile_id: profileId, limit: 500 });
  const byStatus = {};
  for (const j of all) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  }
  const discovered = byStatus.discovered || 0;
  const shortlisted = byStatus.shortlisted || 0;
  const borderline = byStatus.borderline || 0;
  const awaiting_approval = byStatus.awaiting_approval || 0;
  return {
    total: all.length,
    byStatus,
    discovered,
    shortlisted,
    borderline,
    awaiting_approval,
    approved: byStatus.approved || 0,
    hasReviewable: discovered + shortlisted + borderline + awaiting_approval > 0,
  };
}

function handoffStageAfterDiscovery(ceoUserId, profileId, counts) {
  if (counts.discovered > 0) {
    return enqueuePipelineStage('fitscorer', '', ceoUserId, profileId);
  }
  if (counts.hasReviewable) {
    return enqueuePipelineStage(
      'resumetailor',
      'Jobs already in tracker (scored) — tailor and submit CEO Kanban review.',
      ceoUserId,
      profileId
    );
  }
  return enqueuePipelineStage('fitscorer', '', ceoUserId, profileId);
}

function markDiscoveryCompleted(tracker, wf, ceoUserId, profileId, profile, payload, summary) {
  cancelPendingPipelineStage('discovery');
  tracker.completeStep(
    wf.workflow_id,
    'job_discovery',
    payload.actor || { type: 'system', id: 'job_discovery_harvest' },
    payload
  );
  upsertWorkflowStageKanban({
    stage: 'job_discovery',
    ceoUserId,
    profileId,
    profileDisplayName: profile?.display_name || profileId,
    workflowId: wf.workflow_id,
    workflowNumber: wf.workflow_number,
    status: 'completed',
    summary,
    detail: payload,
  });
}

const STAGE_TITLES = {
  discovery: 'Job Discovery — scheduled run',
  fitscorer: 'Fit Scoring — score discovered jobs',
  resumetailor: 'Resume Tailoring — shortlisted jobs',
  applicationagent: 'Application — approved jobs',
};

/** Pipeline delegation stage → job_workflow_steps.step_key */
export const STAGE_WORKFLOW_STEP = {
  discovery: 'job_discovery',
  fitscorer: 'fit_scoring',
  resumetailor: 'resume_tailoring',
  applicationagent: 'application',
};

const PIPELINE_ACTIVE_DELEGATION_STATUSES = ['pending', 'processing'];

function db() {
  return getDb();
}

function parseStage(prompt) {
  const m = String(prompt || '').match(/\[job_pipeline:(\w+)\]/);
  return m ? m[1] : null;
}

export function parsePipelineStage(prompt) {
  return parseStage(prompt);
}

export function isPipelineDelegationPrompt(prompt) {
  return String(prompt || '').includes(PIPELINE_TAG);
}

function listPendingPipelineStages() {
  const standupId = ensurePipelineStandup();
  const rows = db()
    .prepare(
      `SELECT prompt FROM agent_delegation_tasks
       WHERE standup_id = ? AND status = 'pending' AND prompt LIKE ?`
    )
    .all(standupId, `${PIPELINE_TAG}%`);
  return rows.map((r) => parseStage(r.prompt)).filter(Boolean);
}

/** Earliest pending pipeline stage (discovery → fitscorer → …). */
export function getCurrentPendingPipelineStage() {
  const stages = listPendingPipelineStages();
  if (!stages.length) return null;
  return stages.sort(
    (a, b) => PIPELINE_STAGE_ORDER.indexOf(a) - PIPELINE_STAGE_ORDER.indexOf(b)
  )[0];
}

/**
 * Run at most one pipeline delegation per cron tick — the earliest stage only.
 * Later stages wait until discovery (or prior stage) completes.
 */
export function filterPipelineDelegationsForProcessing(pendingTasks) {
  const pipeline = [];
  const other = [];
  for (const t of pendingTasks) {
    if (isPipelineDelegationPrompt(t.prompt)) pipeline.push(t);
    else other.push(t);
  }
  if (!pipeline.length) return pendingTasks;

  let earliestTask = null;
  let earliestIdx = Infinity;
  for (const t of pipeline) {
    const stage = parseStage(t.prompt);
    const idx = PIPELINE_STAGE_ORDER.indexOf(stage);
    if (idx >= 0 && idx < earliestIdx) {
      earliestIdx = idx;
      earliestTask = t;
    }
  }
  return earliestTask ? [...other, earliestTask] : other;
}

function parseProfileFromPrompt(prompt) {
  const m = String(prompt || '').match(/profile_id:\s*(\S+)/);
  return m ? m[1].replace(/[)\]}>,]+$/, '') : null;
}

function workflowTracker(ceoUserId) {
  return getJobWorkflowTracker(() => getDbForCeo(ceoUserId || getDefaultCeoUserId()));
}

function profileService(ceoUserId = null) {
  return createJobSearchProfileService(() => getDbForCeo(ceoUserId || getDefaultCeoUserId()));
}

function jobsService(ceoUserId = null) {
  return createJobApplicationsService(() => getDbForCeo(ceoUserId || getDefaultCeoUserId()));
}

export function getPipelineState() {
  const row = db().prepare('SELECT * FROM job_pipeline_state WHERE id = 1').get();
  return row || { id: 1, standup_id: null, enabled: 0, last_discovery_at: null };
}

export function ensurePipelineStandup() {
  let state = getPipelineState();
  if (!state.standup_id) {
    db()
      .prepare(
        `INSERT INTO standups (scheduled_at, status, source, title) VALUES (datetime('now'), 'active', 'job_pipeline', 'Job Applicant Pipeline')`
      )
      .run();
    const standup = db().prepare('SELECT id FROM standups WHERE source = ? ORDER BY id DESC LIMIT 1').get('job_pipeline');
    db().prepare(
      `INSERT INTO job_pipeline_state (id, standup_id, enabled, updated_at) VALUES (1, ?, 0, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET standup_id = excluded.standup_id, updated_at = datetime('now')`
    ).run(standup.id);
    state = getPipelineState();
  }
  return state.standup_id;
}

export function isJobPipelineStandup(standupId) {
  const state = getPipelineState();
  return state.standup_id != null && Number(state.standup_id) === Number(standupId);
}

function hasPendingPipelineTasks() {
  const standupId = ensurePipelineStandup();
  const placeholders = PIPELINE_ACTIVE_DELEGATION_STATUSES.map(() => '?').join(', ');
  const row = db()
    .prepare(
      `SELECT 1 AS n FROM agent_delegation_tasks
       WHERE standup_id = ? AND status IN (${placeholders}) AND prompt LIKE ? LIMIT 1`
    )
    .get(standupId, ...PIPELINE_ACTIVE_DELEGATION_STATUSES, `${PIPELINE_TAG}%`);
  return !!row;
}

function cancelPendingPipelineStage(stage) {
  const standupId = ensurePipelineStandup();
  db()
    .prepare(
      `UPDATE agent_delegation_tasks
       SET status = 'failed', error_message = 'superseded by pipeline stage completion', completed_at = datetime('now')
       WHERE standup_id = ? AND status IN ('pending', 'processing') AND prompt LIKE ?`
    )
    .run(standupId, `%[job_pipeline:${stage}]%`);
}

function hasPendingStage(stage) {
  const standupId = ensurePipelineStandup();
  const placeholders = PIPELINE_ACTIVE_DELEGATION_STATUSES.map(() => '?').join(', ');
  const row = db()
    .prepare(
      `SELECT 1 AS n FROM agent_delegation_tasks
       WHERE standup_id = ? AND status IN (${placeholders}) AND prompt LIKE ? LIMIT 1`
    )
    .get(standupId, ...PIPELINE_ACTIVE_DELEGATION_STATUSES, `%[job_pipeline:${stage}]%`);
  return !!row;
}

function buildStagePrompt(stage, context = '', { ceoUserId, profileId, intake = {} } = {}) {
  const scope = `ceo_user_id: ${ceoUserId}\nprofile_id: ${profileId || '(active)'}\nAlways pass ceo_user_id and profile_id in profile and job tool calls.`;
  const retry = stage === 'discovery' ? parseDiscoveryRetry(context) : { current: 0, max: DISCOVERY_RETRY_MAX };
  const nonInteractive = `
This is an automated pipeline handoff — NOT an interactive CEO session.
Do NOT ask the CEO questions. Work autonomously using your tools.
Report a concise summary when done (counts, job IDs, errors).
${scope}
${context ? `\nContext: ${context}\n` : ''}`.trim();

  const searchUrls = stage === 'discovery' ? formatDiscoverySearchUrlsForPrompt(intake) : '';
  const paginationBlock = stage === 'discovery' ? buildDiscoveryPaginationBlock(intake) : '';
  const auth = stage === 'discovery' ? getBrowserAuthStatus() : null;
  const browserNote =
    stage === 'discovery' && auth?.session_ready
      ? '\nBrowser session is READY (OpenClaw profile=openclaw). Proceed — dismiss sign-in modals if listings are visible behind them.'
      : stage === 'discovery'
        ? '\nIf login wall blocks all listings: report portal login required (CEO: Connect portals → Save & connect).'
        : '';

  const instructions = {
    discovery: `${nonInteractive}${browserNote}
[discovery_retry:${retry.current}/${retry.max}]
Discover new jobs for profile_id "${profileId}" (use job_search_profile_get — NOT a different profile).
FIRST: job_check_profile_active + job_search_profile_get for this profile_id (read discovery_depth, discovery_min_per_source).
THEN: job_inventory_summary.
Browser: profile=openclaw ONLY. Session cookies are loaded — you are logged in.

Pre-filtered search URLs (navigate to these directly):
${searchUrls || '(build from profile target_titles + locations + sources)'}

${paginationBlock}

Sign-in modal handling (required):
- If a popup/modal says "Sign in" but job listings are visible behind it: snapshot → click Close / Dismiss / X / "Not now" → continue on the search results page.
- Do NOT navigate to /login or stop because of a modal — dismiss it and scrape listings.
- Only report login failure if the entire page is a login wall with zero job listings visible.

Before jobs_append: job_check_url_seen for each URL.
jobs_append every new job with full fields (title, company, location, url, source, job_description).
Do NOT call job_run_workflow_now — pipeline hands off to Fit Scorer automatically.
Report: harvest count, appended count, sample URLs. If below quota, say why (exhausted vs blocked).`,
    fitscorer: `${nonInteractive}\nScore all jobs with status "discovered" for profile_id "${profileId}" using job_fit_score / jobs_update. Shortlist or skip per fit_threshold. Pipeline hands off to Resume Tailor automatically — do NOT call job_run_workflow_now.`,
    resumetailor: `${nonInteractive}\nTailor materials for jobs with status "shortlisted" for profile_id "${profileId}". Update jobs to awaiting_approval. Pipeline creates CEO Kanban review when you finish.`,
    applicationagent: `${nonInteractive}\nApply only to jobs with status "approved" for profile_id "${profileId}". Follow submit_policy. Update job status to applied or failed.`,
  };

  return `[job_pipeline:${stage}]\n${STAGE_TITLES[stage]}\n\n${instructions[stage] || nonInteractive}`;
}

/**
 * Enqueue one pipeline stage: delegation task + Kanban card (visible on board + notifications when done).
 */
export function enqueuePipelineStage(stage, context = '', ceoUserId = getDefaultCeoUserId(), profileId = null) {
  const agentId = STAGE_AGENT[stage];
  if (!agentId) throw new Error(`Unknown pipeline stage: ${stage}`);

  const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);
  if (!gate.active) {
    throw new Error(gate.error || 'Profile not active');
  }
  const resolvedProfileId = gate.profile_id;
  const profile = profileService(ceoUserId).getProfile(ceoUserId, resolvedProfileId);
  const intake = profile?.intake || {};

  const agent = db().prepare('SELECT id, name FROM agents WHERE id = ?').get(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  if (hasPendingStage(stage)) {
    return { skipped: true, reason: 'stage_already_pending', stage };
  }

  const standupId = ensurePipelineStandup();
  const requestId = `job-pipeline-${stage}-${Date.now()}`;
  const prompt = buildStagePrompt(stage, context, { ceoUserId, profileId: resolvedProfileId, intake });

  db()
    .prepare(
      `INSERT INTO agent_delegation_tasks (standup_id, request_id, to_agent_id, prompt, status) VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(standupId, requestId, agentId, prompt);

  const delegation = db().prepare('SELECT id FROM agent_delegation_tasks ORDER BY id DESC LIMIT 1').get();

  const activeWfId = getPipelineState().active_workflow_run_id;
  const title = STAGE_TITLES[stage];
  const descriptionLines = [
    `[job_pipeline:${stage}]`,
    `ceo_user_id: ${ceoUserId}`,
    `profile_id: ${resolvedProfileId}`,
    `stage: ${stage}`,
  ];
  if (activeWfId) descriptionLines.push(`workflow_id: ${activeWfId}`);
  descriptionLines.push('', `Automated job applicant pipeline · stage: ${stage} · ${new Date().toISOString()}`);
  const description = descriptionLines.join('\n');
  db()
    .prepare(
      `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by, standup_id, agent_delegation_task_id)
       VALUES (?, ?, 'awaiting_confirmation', ?, 'job_pipeline', ?, ?)`
    )
    .run(title, description, agentId, standupId, delegation.id);

  return {
    skipped: false,
    stage,
    ceo_user_id: ceoUserId,
    profile_id: resolvedProfileId,
    request_id: requestId,
    delegation_task_id: delegation.id,
    kanban_task_id: db().prepare('SELECT id FROM kanban_tasks WHERE agent_delegation_task_id = ?').get(delegation.id)?.id,
  };
}

function setActiveWorkflowRunId(workflowRunId) {
  db()
    .prepare(
      `UPDATE job_pipeline_state SET active_workflow_run_id = ?, updated_at = datetime('now') WHERE id = 1`
    )
    .run(workflowRunId ?? null);
}

/**
 * Mark workflow run failed when a pipeline delegation fails (Kanban + workflow stay in sync).
 */
export function failPipelineWorkflowForDelegation(failedTask, { error = null } = {}) {
  if (!failedTask || !isJobPipelineStandup(failedTask.standup_id)) return null;

  const stage = parseStage(failedTask.prompt);
  const stepKey = stage ? STAGE_WORKFLOW_STEP[stage] : null;
  if (!stepKey) return null;

  const state = getPipelineState();
  const ceoUserId = state.ceo_user_id || getDefaultCeoUserId();
  const profileId = state.active_profile_id || parseProfileFromPrompt(failedTask.prompt);
  const profile = profileId ? profileService(ceoUserId).getProfile(ceoUserId, profileId) : null;
  const tracker = workflowTracker(ceoUserId);
  let wf =
    (state.active_workflow_run_id && tracker.getRun(state.active_workflow_run_id)) ||
    (profileId ? tracker.findActiveRun(ceoUserId, profileId) : null);

  if (!wf || wf.status !== 'running') {
    return { failed: false, reason: 'no_active_workflow', stage, stepKey };
  }

  const stepRow = wf.steps?.find((s) => s.step_key === stepKey);
  if (stepRow?.status === 'completed') {
    return { failed: false, reason: 'step_already_completed', step_key: stepKey };
  }

  const errMsg = error || failedTask.error_message || 'delegation failed';

  if (stage === 'discovery' && profileId) {
    const counts = summarizeProfileJobs(jobsService(ceoUserId), ceoUserId, profileId);
    if (counts.total > 0) {
      markDiscoveryCompleted(
        tracker,
        wf,
        ceoUserId,
        profileId,
        profile,
        {
          recovered_from_agent_failure: true,
          delegation_task_id: failedTask.id,
          error: errMsg,
          tracker_total: counts.total,
        },
        `Discovery recovered — using ${counts.total} existing job(s) after agent error`
      );
      handoffStageAfterDiscovery(ceoUserId, profileId, counts);
      return {
        failed: false,
        recovered: true,
        workflow_id: wf.workflow_id,
        step_key: stepKey,
        error: errMsg,
      };
    }
  }

  tracker.failStep(wf.workflow_id, stepKey, { type: 'system', id: 'job_pipeline' }, {
    delegation_task_id: failedTask.id,
    error: errMsg,
    stage,
  });
  setActiveWorkflowRunId(null);

  const wfStageKey =
    stepKey === 'job_discovery'
      ? 'job_discovery'
      : stepKey === 'fit_scoring'
        ? 'fit_scoring'
        : stepKey === 'resume_tailoring'
          ? 'resume_tailoring'
          : stepKey;

  upsertWorkflowStageKanban({
    stage: wfStageKey,
    ceoUserId,
    profileId: profileId || profile?.id,
    profileDisplayName: profile?.display_name || profileId,
    workflowId: wf.workflow_id,
    workflowNumber: wf.workflow_number,
    status: 'failed',
    summary: `${STAGE_TITLES[stage] || stage} failed: ${errMsg}`,
    detail: { delegation_task_id: failedTask.id, error: errMsg },
  });

  return { failed: true, workflow_id: wf.workflow_id, step_key: stepKey, error: errMsg };
}

/** Fail pipeline delegations stuck in processing (e.g. after backend restart mid-run). */
export function recoverStaleProcessingDelegations() {
  const timeoutSec = Math.ceil(Number(process.env.DELEGATION_PROCESSING_TIMEOUT_MS || 960000) / 1000);
  const rows = db()
    .prepare(
      `SELECT * FROM agent_delegation_tasks
       WHERE status = 'processing' AND prompt LIKE ?
         AND datetime(created_at) < datetime('now', ? || ' seconds')`
    )
    .all(`${PIPELINE_TAG}%`, `-${timeoutSec}`);

  for (const row of rows) {
    db()
      .prepare(
        `UPDATE agent_delegation_tasks SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`
      )
      .run('processing timeout (stale delegation)', row.id);
    completePipelineKanbanForDelegation(row.id, { ok: false });
    failPipelineWorkflowForDelegation({ ...row, status: 'failed', error_message: 'processing timeout' });
  }
  return rows.length;
}

/**
 * Server harvest first; enqueue agent discovery only when harvest adds no jobs.
 */
async function runDiscoveryStage(ceoUserId, profileId, profile, wf, tracker, { mode = 'async_pipeline', contextPrefix = '' } = {}) {
  tracker.beginStep(wf.workflow_id, 'job_discovery', { type: 'agent', id: 'jobdiscovery' }, { mode });

  let harvestResult = null;
  try {
    harvestResult = await harvestAndAppendJobs(
      ceoUserId,
      profileId,
      profile?.intake || {},
      jobsService(ceoUserId),
      { max_pages: 2, scroll_steps_per_page: 2, per_source_timeout_ms: 120000 }
    );
    if (harvestResult.append?.count_added > 0) {
      createJobApplicantSpreadsheetService(() => getDbForCeo(ceoUserId)).syncProfile(
        ceoUserId,
        profileId,
        profile?.intake
      );
    }
  } catch (e) {
    console.warn('[job-pipeline] server harvest:', e.message);
  }

  const counts = summarizeProfileJobs(jobsService(ceoUserId), ceoUserId, profileId);
  const discoveredCount = counts.discovered;
  const appended = harvestResult?.append?.count_added || 0;

  if (discoveredCount >= 1 || appended >= 1) {
    markDiscoveryCompleted(
      tracker,
      wf,
      ceoUserId,
      profileId,
      profile,
      {
        server_harvest: true,
        jobs_appended: appended,
        discovered_count: discoveredCount,
      },
      `Discovery via server harvest: ${discoveredCount} job(s) ready for fit scoring`
    );
    const fitResult = handoffStageAfterDiscovery(ceoUserId, profileId, {
      ...counts,
      discovered: discoveredCount,
    });
    profileService(ceoUserId).touchPipelineRun(ceoUserId, profileId);
    return {
      mode: 'harvest_server',
      harvest: harvestResult,
      started: fitResult,
      discovered_count: discoveredCount,
    };
  }

  // Tracker already has jobs but harvest found no NEW URLs (all seen) — skip agent discovery.
  if (counts.total > 0) {
    markDiscoveryCompleted(
      tracker,
      wf,
      ceoUserId,
      profileId,
      profile,
      {
        server_harvest: true,
        existing_tracker: true,
        jobs_appended: 0,
        discovered_count: 0,
        tracker_total: counts.total,
        harvest_raw: harvestResult?.harvest_count || 0,
      },
      `Discovery complete — ${counts.total} job(s) already in tracker (harvest added 0 new URLs)`
    );
    const started = handoffStageAfterDiscovery(ceoUserId, profileId, counts);
    profileService(ceoUserId).touchPipelineRun(ceoUserId, profileId);
    return {
      mode: 'existing_tracker',
      harvest: harvestResult,
      started,
      discovered_count: 0,
      tracker_total: counts.total,
    };
  }

  const harvestContext = harvestResult
    ? `${contextPrefix}[server_harvest] Harvest returned 0 valid jobs (${harvestResult.harvest_count || 0} raw, ${harvestResult.rejected?.length || 0} rejected). Call job_portal_harvest_listings ONLY — do NOT call browser action=start.`
    : `${contextPrefix}[server_harvest] No jobs found. Call job_portal_harvest_listings with profile_id — do NOT call browser action=start.`;
  const result = enqueuePipelineStage('discovery', harvestContext, ceoUserId, profileId);
  profileService(ceoUserId).touchPipelineRun(ceoUserId, profileId);
  return {
    mode: 'agent',
    harvest: harvestResult,
    started: result,
    discovered_count: discoveredCount,
  };
}

function beginWorkflowRun(tracker, { ceoUserId, profileId, profile, trigger, actor, supersede = true, detail = {} }) {
  if (supersede) {
    tracker.supersedeRunningRuns(ceoUserId, profileId, actor, { trigger, ...detail });
  }
  const wf = tracker.startRun({
    ceoUserId,
    profileId,
    workflowGoal: profile?.intake?.workflow_goal || profile?.workflow_goal,
    trigger,
    actor,
    metadata: detail,
  });
  setActiveWorkflowRunId(wf.workflow_id);
  return wf;
}

export async function startPipeline(ceoUserId = getDefaultCeoUserId(), profileId = null) {
  const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);
  if (!gate.active) {
    return { ok: false, error: gate.error };
  }
  const profile = profileService(ceoUserId).getProfile(ceoUserId, gate.profile_id);

  try {
    await assertDiscoveryBrowserReady(profile?.intake || {});
  } catch (e) {
    const loginRequired = e instanceof PortalLoginRequiredError || e.login_required;
    return {
      ok: false,
      login_required: loginRequired,
      error: e.message,
      ceo_user_id: ceoUserId,
      profile_id: gate.profile_id,
      next_step: 'Job Profiles → Connect portals → Open login browser → log in → Save & connect',
    };
  }

  ensurePipelineStandup();
  db()
    .prepare(
      `UPDATE job_pipeline_state SET enabled = 1, ceo_user_id = ?, active_profile_id = ?, updated_at = datetime('now') WHERE id = 1`
    )
    .run(ceoUserId, gate.profile_id);
  const tracker = workflowTracker(ceoUserId);
  const actor = { type: 'system', id: 'job_pipeline' };

  if (hasPendingPipelineTasks()) {
    const state = getPipelineState();
    let wf =
      (state.active_workflow_run_id && tracker.getRun(state.active_workflow_run_id)) ||
      tracker.findActiveRun(ceoUserId, gate.profile_id);
    if (!wf) {
      wf = beginWorkflowRun(tracker, {
        ceoUserId,
        profileId: gate.profile_id,
        profile,
        trigger: 'job_pipeline_start',
        actor,
        supersede: true,
      });
    }
    return {
      ok: true,
      message: 'Pipeline enabled; run already in progress',
      ceo_user_id: ceoUserId,
      profile_id: gate.profile_id,
      workflow_id: wf.workflow_id,
      workflow_number: wf.workflow_number,
    };
  }

  const wf = beginWorkflowRun(tracker, {
    ceoUserId,
    profileId: gate.profile_id,
    profile,
    trigger: 'job_pipeline_start',
    actor,
    supersede: true,
  });

  const discovery = await runDiscoveryStage(ceoUserId, gate.profile_id, profile, wf, tracker, {
    mode: 'async_pipeline',
  });

  if (discovery.mode === 'harvest_server') {
    return {
      ok: true,
      mode: 'harvest_server',
      harvest: discovery.harvest,
      started: discovery.started,
      ceo_user_id: ceoUserId,
      profile_id: gate.profile_id,
      workflow_id: wf.workflow_id,
      workflow_number: wf.workflow_number,
      discovered_count: discovery.discovered_count,
      message:
        'Server harvested job listings → Fit Scorer → Resume Tailor → CEO Kanban review. Watch Kanban and Job Workflows.',
    };
  }

  return {
    ok: true,
    mode: 'full_async',
    started: discovery.started,
    ceo_user_id: ceoUserId,
    profile_id: gate.profile_id,
    workflow_id: wf.workflow_id,
    workflow_number: wf.workflow_number,
    message:
      'Full workflow started: Job Discovery → Fit Scorer → Resume Tailor → CEO Kanban review. Watch Kanban and Job Workflows for progress.',
  };
}

export function stopPipeline() {
  db().prepare(`UPDATE job_pipeline_state SET enabled = 0, updated_at = datetime('now') WHERE id = 1`).run();
  return { ok: true, enabled: false };
}

/**
 * After a pipeline delegation task completes, enqueue the next stage (or CEO review after tailoring).
 */
export async function maybeHandoffJobPipeline(completedTask) {
  if (!completedTask || completedTask.status !== 'completed') return null;
  if (!isJobPipelineStandup(completedTask.standup_id)) return null;

  const stage = parseStage(completedTask.prompt);
  if (!stage) return null;

  const state = getPipelineState();
  const ceoUserId = state.ceo_user_id || getDefaultCeoUserId();
  const profileId = state.active_profile_id || parseProfileFromPrompt(completedTask.prompt);
  if (!profileId) return { handoff: null, stage, error: 'no profile_id on pipeline state' };

  const profile = profileService(ceoUserId).getProfile(ceoUserId, profileId);
  const tracker = workflowTracker(ceoUserId);
  let wf =
    (state.active_workflow_run_id && tracker.getRun(state.active_workflow_run_id)) ||
    tracker.findActiveRun(ceoUserId, profileId);
  if (!wf) {
    return { handoff: null, stage, error: 'no active workflow run for pipeline handoff' };
  }

  if (stage === 'discovery') {
    const discoveryStep = wf.steps?.find((s) => s.step_key === 'job_discovery');
    if (discoveryStep?.status === 'completed') {
      return { handoff: null, stage, reason: 'discovery_already_completed' };
    }

    const intake = profile?.intake || {};
    const discoveredCount = jobsService(ceoUserId).list({
      status: 'discovered',
      profile_id: profileId,
      ceo_user_id: ceoUserId,
      limit: 500,
    }).length;
    const assess = assessDiscoveryRun(intake, discoveredCount, completedTask.response_content);
    const retry = parseDiscoveryRetry(completedTask.prompt);

    if (!assess.ok && retry.current < retry.max && !hasPendingStage('discovery')) {
      const nextRetry = retry.current + 1;
      const retryContext =
        `[discovery_retry:${nextRetry}/${retry.max}]\n` +
        `CONTINUE discovery — only ${discoveredCount}/${assess.minRequired} jobs in tracker. ` +
        `Scroll down and paginate more result pages. Do NOT stop at the first screen. ` +
        `Use browser only (no summarize_url). Append remaining jobs in batches.`;
      const retryResult = enqueuePipelineStage('discovery', retryContext, ceoUserId, profileId);
      return {
        handoff: null,
        stage,
        reason: 'discovery_retry',
        discoveredCount,
        minRequired: assess.minRequired,
        retry: nextRetry,
        result: retryResult,
      };
    }

    if (!assess.ok) {
      const trackerCounts = summarizeProfileJobs(jobsService(ceoUserId), ceoUserId, profileId);
      if (trackerCounts.hasReviewable) {
        touchDiscoverySchedule(ceoUserId, profileId);
        tracker.completeStep(wf.workflow_id, 'job_discovery', { type: 'agent', id: 'jobdiscovery' }, {
          delegation_task_id: completedTask.id,
          existing_tracker: true,
          discoveredCount,
          minRequired: assess.minRequired,
        });
        upsertWorkflowStageKanban({
          stage: 'job_discovery',
          ceoUserId,
          profileId,
          profileDisplayName: profile?.display_name || profileId,
          workflowId: wf.workflow_id,
          workflowNumber: wf.workflow_number,
          status: 'completed',
          summary: `Discovery complete — ${trackerCounts.total} job(s) already in tracker`,
          detail: { delegation_task_id: completedTask.id },
        });
        const next = handoffStageAfterDiscovery(ceoUserId, profileId, trackerCounts);
        return { handoff: next?.stage || 'fitscorer', stage, reason: 'existing_tracker_after_agent' };
      }

      const failDetail = {
        delegation_task_id: completedTask.id,
        discoveredCount,
        minRequired: assess.minRequired,
        reason: 'discovery_quota_not_met',
      };
      tracker.failStep(wf.workflow_id, 'job_discovery', { type: 'agent', id: 'jobdiscovery' }, failDetail);
      setActiveWorkflowRunId(null);
      upsertWorkflowStageKanban({
        stage: 'job_discovery',
        ceoUserId,
        profileId,
        profileDisplayName: profile?.display_name || profileId,
        workflowId: wf.workflow_id,
        workflowNumber: wf.workflow_number,
        status: 'failed',
        summary: `Discovery finished below quota (${discoveredCount}/${assess.minRequired} jobs)`,
        detail: failDetail,
      });
      return {
        handoff: null,
        stage,
        reason: 'discovery_quota_not_met',
        discoveredCount,
        minRequired: assess.minRequired,
      };
    }

    touchDiscoverySchedule(ceoUserId, profileId);
    if (wf) {
      tracker.completeStep(wf.workflow_id, 'job_discovery', { type: 'agent', id: 'jobdiscovery' }, {
        delegation_task_id: completedTask.id,
      });
      wf = tracker.getRun(wf.workflow_id);
      upsertWorkflowStageKanban({
        stage: 'job_discovery',
        ceoUserId,
        profileId,
        profileDisplayName: profile?.display_name || profileId,
        workflowId: wf.workflow_id,
        workflowNumber: wf.workflow_number,
        status: 'completed',
        summary: 'Discovery stage finished — handing off to Fit Scorer',
        detail: { delegation_task_id: completedTask.id },
      });
    }
  }

  if (stage === 'fitscorer' && wf) {
    tracker.completeStep(wf.workflow_id, 'fit_scoring', { type: 'agent', id: 'fitscorer' }, {
      delegation_task_id: completedTask.id,
    });
    upsertWorkflowStageKanban({
      stage: 'fit_scoring',
      ceoUserId,
      profileId,
      profileDisplayName: profile?.display_name || profileId,
      workflowId: wf.workflow_id,
      workflowNumber: wf.workflow_number,
      status: 'completed',
      summary: 'Fit scoring finished — handing off to Resume Tailor',
      detail: { delegation_task_id: completedTask.id },
    });
  }

  if (!state.enabled) {
    db().prepare(`UPDATE job_pipeline_state SET enabled = 1, updated_at = datetime('now') WHERE id = 1`).run();
  }

  if (stage === 'resumetailor') {
    if (!profileId) return { handoff: 'ceo_review', error: 'no active profile on pipeline state' };
    wf = wf || tracker.findActiveRun(ceoUserId, profileId);
    try {
      if (wf) {
        tracker.completeStep(wf.workflow_id, 'fit_scoring', { type: 'agent', id: 'fitscorer' }, { handoff: 'resumetailor_complete' });
      }
      const review = await runPhase1SubmitCeoReview({
        ceoUserId,
        profileId,
        tailorShortlisted: true,
        workflowRunId: wf?.workflow_id,
        actor: { type: 'agent', id: 'resumetailor' },
        skipWorkflowSteps: false,
      });
      return {
        handoff: 'ceo_review',
        kanban_task_id: review.kanban?.kanban_task_id,
        awaiting_approval_count: review.awaiting_approval_count,
        workflow_id: review.workflow_id,
        workflow_number: review.workflow_number,
      };
    } catch (e) {
      return { handoff: 'ceo_review', error: e.message };
    }
  }

  const next = STAGE_NEXT[stage];
  if (!next) return { handoff: null, stage, reason: 'terminal_or_ceo_gate' };

  if (hasPendingStage(next)) {
    return { handoff: null, stage, reason: 'next_stage_already_pending', next };
  }

  const result = enqueuePipelineStage(next, '', ceoUserId, profileId);
  return { handoff: next, result };
}

/**
 * If approved jobs exist and application stage is idle, enqueue application agent.
 */
export function enqueueApplicationStageIfNeeded(ceoUserId = getDefaultCeoUserId()) {
  const state = getPipelineState();
  if (!state.enabled) return null;
  const gate = profileService(ceoUserId).assertActive(ceoUserId);
  if (!gate.active) return null;
  if (!requiresJobApplication(gate.profile)) return { skipped: true, reason: 'scoring_summary_profile' };

  const approved = jobsService(ceoUserId).list({
    status: 'approved',
    limit: 1,
    ceo_user_id: ceoUserId,
    profile_id: gate.profile_id,
  });
  if (approved.length === 0) return null;
  if (hasPendingStage('applicationagent')) return null;
  if (hasPendingPipelineTasks()) return null;

  return enqueuePipelineStage('applicationagent', `${approved.length}+ approved job(s) ready`, ceoUserId);
}

function parseIntakeJson(row) {
  try {
    return JSON.parse(row?.intake_json || '{}');
  } catch {
    return {};
  }
}

function workflowDueForProfile(row) {
  const intake = parseIntakeJson(row);
  const schedule = normalizeDiscoverySchedule(intake.discovery_schedule);
  return {
    schedule,
    due: isScheduleDue(schedule, row.last_pipeline_run_at),
    last_run_at: row.last_pipeline_run_at || null,
  };
}

/**
 * Run scheduled discovery for one active profile (if due per workflow_schedule).
 */
export async function runPipelineTick(ceoUserId = getDefaultCeoUserId(), profileId = null) {
  const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);
  if (!gate.active) return { ran: false, reason: 'profile_not_active', error: gate.error, ceo_user_id: ceoUserId, profile_id: profileId };

  const db = getDb();
  const row = db
    .prepare('SELECT * FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?')
    .get(ceoUserId, gate.profile_id);
  const { schedule, due, last_run_at } = workflowDueForProfile(row);

  const results = { schedule, last_run_at, due };

  if (schedule === 'manual') {
    results.skipped = true;
    results.reason = 'manual_schedule';
    return { ran: false, ceo_user_id: ceoUserId, profile_id: gate.profile_id, results };
  }

  if (!hasPendingPipelineTasks() && due) {
    ensurePipelineStandup();
    db()
      .prepare(
        `UPDATE job_pipeline_state SET enabled = 1, ceo_user_id = ?, active_profile_id = ?, updated_at = datetime('now') WHERE id = 1`
      )
      .run(ceoUserId, gate.profile_id);
    const profile = profileService(ceoUserId).getProfile(ceoUserId, gate.profile_id);
    const tracker = workflowTracker(ceoUserId);
    const wf = beginWorkflowRun(tracker, {
      ceoUserId,
      profileId: gate.profile_id,
      profile,
      trigger: 'scheduled_pipeline',
      actor: { type: 'system', id: 'job_pipeline_cron' },
      supersede: true,
    });
    results.discovery = await runDiscoveryStage(ceoUserId, gate.profile_id, profile, wf, tracker, {
      mode: 'scheduled',
      contextPrefix: `Scheduled ${schedule} workflow run. `,
    });
    results.workflow_id = wf.workflow_id;
    results.workflow_number = wf.workflow_number;
    profileService(ceoUserId).touchPipelineRun(ceoUserId, gate.profile_id);
    db().prepare(`UPDATE job_pipeline_state SET last_discovery_at = datetime('now'), updated_at = datetime('now') WHERE id = 1`).run();
  } else if (!due) {
    results.skipped = true;
    results.reason = 'not_due';
  } else if (hasPendingPipelineTasks()) {
    results.skipped = true;
    results.reason = 'pipeline_busy';
  }

  if (getPipelineState().enabled) {
    results.application = enqueueApplicationStageIfNeeded(ceoUserId);
  }

  return { ran: true, ceo_user_id: ceoUserId, profile_id: gate.profile_id, results };
}

/**
 * Cron: check every active profile's workflow_schedule and run discovery when due.
 */
export async function runPipelineTickAll() {
  const rows = profileService().listActiveProfiles();
  const tickResults = [];
  for (const row of rows) {
    tickResults.push(await runPipelineTick(row.ceo_user_id, row.id));
  }
  return { ran: true, profiles_checked: rows.length, results: tickResults };
}

export function getPipelineStatus(ceoUserId = getDefaultCeoUserId()) {
  const state = getPipelineState();
  const activeProfileId = profileService(ceoUserId).getActiveProfileId(ceoUserId);
  const profile = activeProfileId
    ? profileService(ceoUserId).getProfile(ceoUserId, activeProfileId)
    : profileService(ceoUserId).getProfile(ceoUserId);
  const schedule = normalizeDiscoverySchedule(profile.intake?.discovery_schedule);
  const intervalMs = scheduleIntervalMs(schedule);
  let next_run_at = null;
  if (intervalMs && profile.last_pipeline_run_at) {
    next_run_at = new Date(new Date(profile.last_pipeline_run_at).getTime() + intervalMs).toISOString();
  } else if (intervalMs && schedule !== 'manual') {
    next_run_at = 'due now';
  }
  const standupId = state.standup_id;
  let pending_stages = [];
  if (standupId) {
    pending_stages = db()
      .prepare(
        `SELECT id, to_agent_id, prompt, status, created_at FROM agent_delegation_tasks
         WHERE standup_id = ? AND prompt LIKE ? ORDER BY created_at DESC LIMIT 10`
      )
      .all(standupId, `${PIPELINE_TAG}%`)
      .map((t) => ({
        id: t.id,
        agent_id: t.to_agent_id,
        stage: parseStage(t.prompt),
        status: t.status,
        created_at: t.created_at,
      }));
  }
  return {
    enabled: !!state.enabled,
    ceo_user_id: ceoUserId,
    active_profile_id: activeProfileId,
    active_profile_display_name: activeProfileId
      ? profileService(ceoUserId).getProfile(ceoUserId, activeProfileId)?.display_name || activeProfileId
      : null,
    profile_status: profile.status,
    workflow_schedule: schedule,
    workflow_schedule_label: scheduleLabel(schedule),
    last_pipeline_run_at: profile.last_pipeline_run_at || null,
    next_run_at,
    standup_id: standupId,
    last_discovery_at: state.last_discovery_at,
    pending_pipeline_tasks: hasPendingPipelineTasks(),
    current_pipeline_stage: getCurrentPendingPipelineStage(),
    pipeline_stage_order: PIPELINE_STAGE_ORDER,
    recent_pipeline_tasks: pending_stages,
    job_counts: {
      discovered: jobsService(ceoUserId).list({ status: 'discovered', limit: 500, ceo_user_id: ceoUserId, profile_id: activeProfileId }).length,
      shortlisted: jobsService(ceoUserId).list({ status: 'shortlisted', limit: 500, ceo_user_id: ceoUserId, profile_id: activeProfileId }).length,
      awaiting_approval: jobsService(ceoUserId).list({ status: 'awaiting_approval', limit: 500, ceo_user_id: ceoUserId, profile_id: activeProfileId }).length,
      acknowledged: jobsService(ceoUserId).list({ status: 'acknowledged', limit: 500, ceo_user_id: ceoUserId, profile_id: activeProfileId }).length,
      approved: jobsService(ceoUserId).list({ status: 'approved', limit: 500, ceo_user_id: ceoUserId, profile_id: activeProfileId }).length,
    },
  };
}

/**
 * Mark discovery stage complete for schedule tracking (called from handoff).
 */
export function touchDiscoverySchedule(ceoUserId, profileId) {
  if (ceoUserId && profileId) {
    profileService(ceoUserId).touchPipelineRun(ceoUserId, profileId);
  }
  db().prepare(`UPDATE job_pipeline_state SET last_discovery_at = datetime('now'), updated_at = datetime('now') WHERE id = 1`).run();
}
