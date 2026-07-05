/**
 * Run the full job search workflow in one call: score discovered → tailor → CEO Kanban review.
 * Use after interactive discovery (jobs_append) or when CEO asks to "run pipeline now".
 */
import { getDbForCeo } from '../db/request-db.js';
import { getDefaultCeoUserId } from './job-applicant-ceo.js';
import { createJobSearchProfileService } from './job-search-profile.js';
import { createJobApplicationsService } from './job-applications.js';
import { scoreDiscoveredJobsForProfile } from './job-applicant-fit-score.js';
import { runPhase1SubmitCeoReview } from './job-applicant-ceo-review.js';
import { startPipeline, summarizeProfileJobs } from './job-applicant-pipeline.js';
import { getJobWorkflowTracker } from './job-workflow-tracker.js';
import { upsertWorkflowStageKanban } from './kanban-workflow-stage.js';

function resolveProfile(profileSvc, ceoUserId, profileId) {
  const pid = profileId || profileSvc.getActiveProfileId(ceoUserId);
  if (!pid) throw new Error('profile_id required (no active profile)');
  const profile = profileSvc.getProfile(ceoUserId, pid);
  if (!profile?.id || profile.status === 'none') {
    throw new Error(`Profile not found: ${pid}`);
  }
  if (profile.status === 'inactive') {
    throw new Error(`Profile "${pid}" is deactivated. Reactivate via job_search_profile_confirm first.`);
  }
  if (profile.status === 'draft') {
    throw new Error(
      `Profile "${pid}" is draft. Confirm with job_search_profile_confirm before running discovery or workflow.`
    );
  }
  return { profile, profileId: pid };
}

/**
 * Full workflow: discovery (async agents) when tracker is empty, else score → tailor → CEO review.
 */
export async function runFullJobWorkflow(ceoUserId, profileId = null, opts = {}) {
  const { forceDiscovery = false, ...workflowOpts } = opts;
  const profileSvc = createJobSearchProfileService(() => getDbForCeo(ceoUserId || getDefaultCeoUserId()));
  const jobsSvc = createJobApplicationsService(() => getDbForCeo(ceoUserId || getDefaultCeoUserId()));
  const { profileId: pid } = resolveProfile(profileSvc, ceoUserId, profileId);
  const counts = summarizeProfileJobs(jobsSvc, ceoUserId, pid);

  // Tracker already has jobs — use sync score → tailor → CEO path (avoids re-discovery agent failures).
  if (!forceDiscovery && counts.hasReviewable) {
    return runJobSearchWorkflowNow(ceoUserId, pid, { ...workflowOpts, runDiscoveryIfEmpty: false });
  }

  if (forceDiscovery || counts.total === 0) {
    const started = await startPipeline(ceoUserId, pid);
    if (!started.ok) return started;
    return {
      ok: true,
      mode: started.mode || 'full_async',
      profile_id: pid,
      ...started,
      next_step:
        started.mode === 'existing_tracker'
          ? 'Existing jobs in tracker — Fit Scorer / Resume Tailor → CEO Kanban review follow via agent handoff.'
          : started.mode === 'harvest_server'
            ? 'Server harvested listings → Fit Scorer → Resume Tailor → CEO Kanban review. Watch Kanban and Job Workflows.'
            : 'Job Discovery is searching LinkedIn/JobStreet. Fit Scorer → Resume Tailor → CEO Kanban review follow automatically.',
    };
  }

  return runJobSearchWorkflowNow(ceoUserId, pid, { ...workflowOpts, runDiscoveryIfEmpty: false });
}

/**
 * Synchronous workflow to Kanban CEO review (predictable chat UX).
 * Assumes jobs already discovered via jobs_append or a prior pipeline discovery stage.
 */
export async function runJobSearchWorkflowNow(ceoUserId, profileId = null, opts = {}) {
  const {
    scoreDiscovered = true,
    submitReview = true,
    tailorShortlisted = true,
    actor = { type: 'system', id: 'job_run_workflow_now' },
    trigger = 'job_run_workflow_now',
    workflow_run_id = null,
    runDiscoveryIfEmpty = true,
  } = opts;

  const profileSvc = createJobSearchProfileService(() => getDbForCeo(ceoUserId));
  const jobsSvc = createJobApplicationsService(() => getDbForCeo(ceoUserId));
  const tracker = getJobWorkflowTracker(() => getDbForCeo(ceoUserId));

  const { profile, profileId: pid } = resolveProfile(profileSvc, ceoUserId, profileId);

  const jobCountsBefore = {
    discovered: jobsSvc.list({ status: 'discovered', ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length,
    shortlisted: jobsSvc.list({ status: 'shortlisted', ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length,
    borderline: jobsSvc.list({ status: 'borderline', ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length,
    awaiting_approval: jobsSvc.list({ status: 'awaiting_approval', ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length,
  };

  if (
    runDiscoveryIfEmpty &&
    jobCountsBefore.discovered === 0 &&
    jobCountsBefore.shortlisted === 0 &&
    jobCountsBefore.borderline === 0 &&
    jobCountsBefore.awaiting_approval === 0
  ) {
    const total = jobsSvc.list({ ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length;
    if (total === 0) {
      return runFullJobWorkflow(ceoUserId, pid, { forceDiscovery: true, ...opts, runDiscoveryIfEmpty: false });
    }
  }

  let wf = workflow_run_id ? tracker.getRun(workflow_run_id) : null;
  if (!wf) {
    tracker.supersedeRunningRuns(ceoUserId, pid, actor, { trigger, reason: 'new_manual_workflow_run' });
    wf = tracker.startRun({
      ceoUserId,
      profileId: pid,
      workflowGoal: profile.workflow_goal || profile.intake?.workflow_goal,
      trigger,
      actor,
    });
    getDbForCeo(ceoUserId)
      .prepare(
        `UPDATE job_pipeline_state SET active_workflow_run_id = ?, updated_at = datetime('now') WHERE id = 1`
      )
      .run(wf.workflow_id);
  }
  const wfId = wf.workflow_id;

  const steps = [];
  let scoring = null;
  try {
    if (jobCountsBefore.discovered > 0) {
      tracker.completeStep(wfId, 'job_discovery', actor, { jobs_discovered: jobCountsBefore.discovered });
    } else {
      tracker.completeStep(wfId, 'job_discovery', actor, { note: 'discovery in prior session' });
    }

    if (scoreDiscovered && jobCountsBefore.discovered > 0) {
      tracker.beginStep(wfId, 'fit_scoring', { type: 'agent', id: 'fitscorer' });
      scoring = await scoreDiscoveredJobsForProfile(ceoUserId, pid, profile, jobsSvc);
      tracker.completeStep(wfId, 'fit_scoring', { type: 'agent', id: 'fitscorer' }, {
        scored: scoring.scored,
        shortlisted: scoring.shortlisted,
        skipped: scoring.skipped,
      });
      upsertWorkflowStageKanban({
        stage: 'fit_scoring',
        ceoUserId,
        profileId: pid,
        profileDisplayName: profile.display_name || pid,
        workflowId: wfId,
        workflowNumber: wf.workflow_number,
        status: 'completed',
        summary: `Scored ${scoring.scored} job(s): ${scoring.shortlisted} shortlisted, ${scoring.borderline || 0} borderline, ${scoring.skipped} skipped`,
        detail: scoring,
      });
      steps.push(`Scored ${scoring.scored} discovered job(s): ${scoring.shortlisted} shortlisted, ${scoring.borderline || 0} borderline, ${scoring.skipped} skipped`);
    } else if (jobCountsBefore.discovered > 0) {
      tracker.skipStep(wfId, 'fit_scoring', actor, { reason: 'score_discovered false' });
      steps.push(`${jobCountsBefore.discovered} job(s) still discovered — enable score_discovered or score manually`);
    } else {
      tracker.completeStep(wfId, 'fit_scoring', actor, { note: 'nothing to score' });
    }

    let review = null;
    if (submitReview) {
      tracker.beginStep(wfId, 'resume_tailoring', { type: 'agent', id: 'resumetailor' });
      review = await runPhase1SubmitCeoReview({
        ceoUserId,
        profileId: pid,
        tailorShortlisted,
        workflowRunId: wfId,
        actor,
        skipWorkflowSteps: true,
      });
      tracker.completeStep(wfId, 'resume_tailoring', { type: 'agent', id: 'resumetailor' }, {
        tailored_count: review.tailored_count,
      });
      upsertWorkflowStageKanban({
        stage: 'resume_tailoring',
        ceoUserId,
        profileId: pid,
        profileDisplayName: profile.display_name || pid,
        workflowId: wfId,
        workflowNumber: wf.workflow_number,
        status: 'completed',
        summary: `Tailored ${review.tailored_count ?? 0} job(s); ${review.awaiting_approval_count ?? 0} awaiting CEO approval`,
        detail: {
          tailored_count: review.tailored_count,
          awaiting_approval_count: review.awaiting_approval_count,
          kanban_task_id: review.kanban?.kanban_task_id,
        },
      });
      tracker.completeStep(wfId, 'ceo_review', actor, {
        kanban_task_id: review.kanban?.kanban_task_id,
        awaiting_approval_count: review.awaiting_approval_count,
      });
      tracker.beginStep(wfId, 'ceo_confirm', { type: 'user', id: ceoUserId }, { waiting: 'CEO Kanban confirm' });
      if (review.kanban?.kanban_task_id) {
        tracker.linkKanban(wfId, review.kanban.kanban_task_id);
      }
      steps.push(
        `Tailored shortlisted jobs; CEO review Kanban #${review.kanban?.kanban_task_id || '?'} (${review.awaiting_approval_count || 0} awaiting approval)`
      );
    } else {
      tracker.skipStep(wfId, 'resume_tailoring', actor, { reason: 'submit_review false' });
      tracker.skipStep(wfId, 'ceo_review', actor, { reason: 'submit_review false' });
    }

    const jobCountsAfter = {
      discovered: jobsSvc.list({ status: 'discovered', ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length,
      shortlisted: jobsSvc.list({ status: 'shortlisted', ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length,
      awaiting_approval: jobsSvc.list({ status: 'awaiting_approval', ceo_user_id: ceoUserId, profile_id: pid, limit: 500 }).length,
    };

    const kanbanId = review?.kanban?.kanban_task_id;
    let nextStep;
    if (kanbanId && jobCountsAfter.awaiting_approval > 0) {
      nextStep = `Open Kanban → task #${kanbanId}. Workflow #${wf.workflow_number} (id ${wfId}) awaiting CEO confirm. View progress: /job-workflows?profile_id=${pid}&workflow_id=${wfId}`;
    } else if (jobCountsAfter.awaiting_approval === 0 && jobCountsAfter.shortlisted > 0) {
      nextStep = 'Jobs shortlisted but not yet awaiting approval — run job_run_workflow_now again or job_phase1_submit_ceo_review.';
    } else if (jobCountsAfter.discovered > 0) {
      nextStep = 'Jobs still in discovered status — workflow will score them on next run (score_discovered defaults true).';
    } else {
      nextStep = 'No jobs ready for CEO review. Run discovery first (browser + jobs_append), then call job_run_workflow_now.';
    }

    const progress = tracker.getRun(wfId);

    return {
      ok: true,
      workflow_id: wfId,
      workflow_number: wf.workflow_number,
      workflow: progress,
      ceo_user_id: ceoUserId,
      profile_id: pid,
      profile_status: profile.status,
      steps,
      scoring,
      review,
      job_counts_before: jobCountsBefore,
      job_counts_after: jobCountsAfter,
      kanban_task_id: kanbanId,
      kanban_status: review?.kanban?.status,
      awaiting_approval_count: review?.awaiting_approval_count ?? jobCountsAfter.awaiting_approval,
      next_step: nextStep,
      message: kanbanId
        ? `Workflow #${wf.workflow_number}: CEO review Kanban task #${kanbanId} — ${jobCountsAfter.awaiting_approval} job(s) ready for your approval.`
        : `Workflow #${wf.workflow_number} ran but no CEO review task created. ${nextStep}`,
    };
  } catch (err) {
    tracker.failInProgressStep(wfId, actor, { error: err.message });
    throw err;
  }
}

/** Start async delegation pipeline (discovery → fitscorer → resumetailor → auto CEO Kanban). */
export async function runJobPipelineStart(ceoUserId, profileId = null) {
  const profileSvc = createJobSearchProfileService(() => getDbForCeo(ceoUserId || getDefaultCeoUserId()));
  resolveProfile(profileSvc, ceoUserId, profileId);
  const started = await startPipeline(ceoUserId, profileId);
  if (!started.ok) throw new Error(started.error || 'Pipeline start failed');
  return {
    ...started,
    mode: 'full_async',
    next_step:
      started.message ||
      'Async pipeline started. Kanban cards appear under each agent column. After Resume Tailoring completes, CEO review task appears under Unassigned → Awaiting confirmation.',
  };
}
