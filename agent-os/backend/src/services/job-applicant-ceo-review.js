/**
 * Consolidated CEO review Kanban for Phase 1 — shortlist summary,
 * job portal links, resume (Drive/local) links, await confirmation to apply.
 */
import { getDb } from '../db/schema.js';
import { getDbForCeo } from '../db/request-db.js';
import { createJobSearchProfileService, coerceConfirm } from './job-search-profile.js';
import { createJobApplicationsService } from './job-applications.js';
import { createJobApplicantSpreadsheetService, getSpreadsheetPaths } from './job-applicant-spreadsheet.js';
import {
  buildGoogleSheetLink,
  buildGDriveFolderLink,
  buildTrackerApiLinks,
  buildResumeStorageLabel,
} from './job-applicant-links.js';
import { tailorResumeForJob } from './job-applicant-resume.js';
import { onCeoReviewApproved } from './job-applicant-prefill.js';
import {
  requiresJobApplication,
  workflowGoalLabel,
  normalizeWorkflowGoal,
} from './job-applicant-workflow-goal.js';
import { getJobWorkflowTracker } from './job-workflow-tracker.js';
import { parseBorderlineReview } from './job-candidate-context.js';

const REVIEW_TAG = 'ceo_review_profile:';

/** Build Google Drive folder or file link from profile intake + job. */
export function buildResumeDriveLink(profile, job, variantPath) {
  return buildResumeStorageLabel(profile, variantPath || job?.resume_variant_path);
}

export function buildSheetLink(profile) {
  return buildGoogleSheetLink(profile.intake?.google_sheet_id);
}

function formatJobBlock(job, profile, index) {
  const portal = job.url || '(no portal URL)';
  const resumeLink = buildResumeStorageLabel(profile, job.resume_variant_path, job);
  const coverLink = job.cover_letter_pdf_url
    ? `[Cover letter PDF](${job.cover_letter_pdf_url})`
    : job.cover_letter_path
      ? `Local: ${job.cover_letter_path}`
      : null;
  const lines = [
    `### ${index}. ${job.title || 'Untitled'} — ${job.company || 'Unknown'}`,
    `- **job_id:** \`${job.job_id}\``,
    `- **Job portal:** ${portal.startsWith('http') ? `[${portal}](${portal})` : portal}`,
    `- **Source:** ${job.source || '—'}`,
    `- **Location:** ${job.location || '—'}`,
    `- **Fit score:** ${job.fit_score ?? '—'}%`,
  ];
  if (job.fit_rationale) lines.push(`- **Fit rationale:** ${job.fit_rationale}`);
  lines.push(`- **Resume (master PDF, reused):** ${resumeLink}`);
  if (coverLink) lines.push(`- **Cover letter PDF:** ${coverLink}`);
  if (job.tailoring_notes) lines.push(`- **Tailoring notes:** ${String(job.tailoring_notes).slice(0, 400)}`);
  if (job.why_me_summary) lines.push(`- **Why me:** ${job.why_me_summary}`);
  lines.push('');
  return lines.join('\n');
}

export function buildCeoReviewDescription(jobs, profile, spreadsheetInfo, workflowMeta = null) {
  const intake = profile.intake || {};
  const titles = Array.isArray(intake.target_titles) ? intake.target_titles.join(', ') : '';
  const threshold = intake.fit_threshold ?? 80;
  const masterResume = intake.master_resume_path || '(not set)';
  const masterDrive = buildResumeDriveLink(profile, { job_id: 'master', company: 'Master' }, masterResume);
  const sheetLink = buildSheetLink(profile);
  const apiLinks = spreadsheetInfo?.tracker_links || buildTrackerApiLinks(profile.ceo_user_id, profile.id);
  const gdriveLink = buildGDriveFolderLink(intake.gdrive_root_folder);

  const awaiting = jobs.filter((j) => j.status === 'awaiting_approval');
  const shortlisted = jobs.filter((j) =>
    ['shortlisted', 'resume_ready', 'awaiting_approval'].includes(j.status)
  );
  const borderline = jobs.filter((j) => j.status === 'borderline');
  const borderlineCfg = parseBorderlineReview(intake);
  const reviewJobs = awaiting.length > 0 ? awaiting : shortlisted;
  const goal = normalizeWorkflowGoal(intake.workflow_goal);
  const forApplication = goal === 'job_application';

  const lines = [
    `${REVIEW_TAG}${profile.id}`,
    `ceo_user_id: ${profile.ceo_user_id}`,
    `profile_id: ${profile.id}`,
    ...(workflowMeta?.workflow_id
      ? [`workflow_id: ${workflowMeta.workflow_id}`, `workflow_number: ${workflowMeta.workflow_number}`]
      : []),
    `workflow_goal: ${goal}`,
    `phase: 1`,
    `action: ${forApplication ? 'await_confirmation_to_apply' : 'await_confirmation_scoring_summary'}`,
    '',
    '## Action required',
    forApplication
      ? '**Review tailored resume PDFs and cover letters below, then confirm in Kanban to proceed with applications.**\nUntil you approve, the Application Agent will not submit any forms.'
      : '**Review the scoring summary below and confirm in Kanban to acknowledge.**\nNo applications will be submitted for this profile — jobs move to **acknowledged** in your tracker.',
    '',
    '## Job search profile',
    `- **profile_id:** \`${profile.id}\``,
    `- **display_name:** ${profile.display_name || profile.id}`,
    `- **Workflow goal:** ${workflowGoalLabel(goal)}`,
    `- **Target titles:** ${titles}`,
    `- **Fit threshold:** ${threshold}%`,
    `- **Borderline band (CEO can include):** ${borderlineCfg.enabled ? `${borderlineCfg.min_score}%–${threshold - 1}%` : 'disabled'}`,
    `- **Workflow schedule:** ${intake.workflow_schedule || intake.discovery_schedule || 'daily'} _(each profile runs on its own schedule)_`,
    `- **Sources:** ${Array.isArray(intake.sources) ? intake.sources.join(', ') : intake.sources || '—'}`,
    `- **Jobs in this review:** ${reviewJobs.length}`,
    `- **LinkedIn profile:** ${intake.linkedin_profile ? `[${intake.linkedin_profile}](${intake.linkedin_profile})` : '(not set)'}`,
    '',
    '## Master resume',
    `- **Path:** ${masterResume}`,
    `- **Storage:** ${masterDrive}`,
    '',
  ];

  lines.push(
    '## Job tracker spreadsheet',
    `_All rows are tagged with profile_id \`${profile.id}\` (${profile.display_name || profile.id})._`,
    `- [Download CSV tracker](${apiLinks.csv_download})`,
    `- [View matches summary](${apiLinks.summary_view})`,
  );
  if (sheetLink) {
    lines.push(`- [Google Sheet (live sync)](${sheetLink})`);
  } else {
    lines.push('- _Google Sheet: not configured — using local CSV above. Set a real `google_sheet_id` in profile to enable._');
  }
  if (gdriveLink) {
    lines.push(`- [Google Drive folder](${gdriveLink})`);
  } else {
    lines.push('- _Google Drive: not configured — resumes stored locally until you set `gdrive_root_folder`._');
  }
  lines.push(
    '',
    `## Shortlist summary (≥${threshold}% match)`,
    ''
  );

  if (reviewJobs.length === 0) {
    lines.push('_No jobs at or above threshold yet._');
  } else {
    reviewJobs.forEach((j, i) => lines.push(formatJobBlock(j, profile, i + 1)));
  }

  if (borderlineCfg.enabled && borderline.length > 0) {
    lines.push(
      '',
      `## Below threshold — include selectively (${borderlineCfg.min_score}%–${threshold - 1}%)`,
      '',
      '_These jobs scored below your auto-shortlist threshold. In Kanban UI click **Include in approval** per job, or call `job_ceo_review_include` with selected `job_ids`._',
      ''
    );
    borderline.forEach((j, i) => {
      lines.push(formatJobBlock(j, profile, i + 1));
      lines.push(`- **Include:** \`job_ceo_review_include\` with \`{ "job_ids": ["${j.job_id}"] }\``);
      lines.push('');
    });
  }

  lines.push(
    '## How to approve',
    '1. Reply in this Kanban task with **confirm** / **approve**, or',
    forApplication
      ? '2. Call `jobs_update` with `{ "job_id": "...", "patch": { "status": "approved", "owner_action": "approve" } }` per job, or'
      : '2. Call `jobs_update` with `{ "job_id": "...", "patch": { "status": "acknowledged", "owner_action": "acknowledge" } }` per job, or',
    '3. Confirm all: `job_ceo_review_confirm` with `{ "confirm": true }`',
    '',
    forApplication
      ? '## Do not apply until CEO confirms\nApplication Agent runs only after approval.'
      : '## Scoring summary only\nAfter confirm, jobs are marked **acknowledged** — workflow closes; Application Agent is not used.'
  );

  return lines.join('\n');
}

/** Jobs that still need PDF tailoring before CEO review. */
export function listJobsNeedingTailor(jobsSvc, ceoUserId, profileId) {
  const shortlisted = jobsSvc.list({
    status: 'shortlisted',
    ceo_user_id: ceoUserId,
    profile_id: profileId,
    limit: 100,
  });
  const awaiting = jobsSvc.list({
    status: 'awaiting_approval',
    ceo_user_id: ceoUserId,
    profile_id: profileId,
    limit: 100,
  });
  const needsPdf = awaiting.filter((j) => {
    if (j.materials_ready && j.cover_letter_path && String(j.cover_letter_path).toLowerCase().endsWith('.pdf')) {
      return false;
    }
    if (j.cover_letter_path && String(j.cover_letter_path).toLowerCase().endsWith('.pdf') && j.why_me_summary) {
      return false;
    }
    return true;
  });
  const byId = new Map();
  for (const j of [...shortlisted, ...needsPdf]) byId.set(j.job_id, j);
  return [...byId.values()];
}

export async function tailorJobsForReview(ceoUserId, profileId, jobs, jobsSvc) {
  const tailored = [];
  for (const job of jobs) {
    if (
      job.status === 'awaiting_approval' &&
      job.materials_ready &&
      job.cover_letter_path &&
      String(job.cover_letter_path).toLowerCase().endsWith('.pdf')
    ) {
      tailored.push({ job_id: job.job_id, skipped: true, reason: 'already_tailored' });
      continue;
    }
    const result = await tailorResumeForJob({
      ceoUserId,
      profileId,
      jobId: job.job_id,
      syncSpreadsheet: false,
      createKanban: false,
    });
    jobsSvc.update(job.job_id, {
      extra: {
        resume_variant_path: result.resume_variant_path,
        cover_letter_path: result.cover_letter_path,
        resume_pdf_url: result.material_links?.resume_pdf,
        cover_letter_pdf_url: result.material_links?.cover_letter_pdf,
        materials_ready: true,
      },
    });
    tailored.push({
      job_id: job.job_id,
      resume_variant_path: result.resume_variant_path,
      cover_letter_path: result.cover_letter_path,
      material_links: result.material_links,
    });
  }
  return tailored;
}

export function findExistingCeoReviewKanban(profileId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, title, status, description FROM kanban_tasks
       WHERE description LIKE ? AND status IN ('open', 'awaiting_confirmation', 'in_progress')
       ORDER BY id DESC LIMIT 1`
    )
    .get(`${REVIEW_TAG}${profileId}%`);
}

export function createConsolidatedCeoReviewKanban(ceoUserId, profileId, jobs, profile, spreadsheetInfo, workflowMeta = null) {
  const db = getDb();
  const existing = findExistingCeoReviewKanban(profileId);
  const description = buildCeoReviewDescription(jobs, profile, spreadsheetInfo, workflowMeta);
  const count = jobs.filter((j) => j.status === 'awaiting_approval').length;
  const borderlineCount = jobs.filter((j) => j.status === 'borderline').length;
  const titleSuffix =
    count > 0
      ? `${count} job${count === 1 ? '' : 's'}`
      : borderlineCount > 0
        ? `${borderlineCount} borderline`
        : '0 jobs';
  const title = `CEO Review: Confirm applications (${titleSuffix}) — ${profile.display_name || profileId}`;

  if (existing) {
    db.prepare(`UPDATE kanban_tasks SET title = ?, description = ?, status = 'awaiting_confirmation', updated_at = datetime('now') WHERE id = ?`).run(
      title,
      description,
      existing.id
    );
    return { kanban_task_id: existing.id, created: false, updated: true, title, status: 'awaiting_confirmation' };
  }

  db.prepare(
    `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by, due_date)
     VALUES (?, ?, 'awaiting_confirmation', NULL, 'job_pipeline', NULL)`
  ).run(title, description);

  const row = db.prepare('SELECT id FROM kanban_tasks ORDER BY id DESC LIMIT 1').get();
  return { kanban_task_id: row?.id, created: true, updated: false, title, status: 'awaiting_confirmation' };
}

/** Jobs available for CEO review UI (primary + borderline). */
export function getCeoReviewQueue(ceoUserId, profileId) {
  const profileSvc = createJobSearchProfileService(() => getDb());
  const jobsSvc = createJobApplicationsService(() => getDb());
  const profile = profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id) throw new Error(`Profile not found: ${profileId}`);

  const all = jobsSvc.list({ ceo_user_id: ceoUserId, profile_id: profileId, limit: 500 });
  const threshold = Number(profile.intake?.fit_threshold) || 70;
  const borderlineCfg = parseBorderlineReview(profile.intake);

  return {
    profile_id: profileId,
    fit_threshold: threshold,
    borderline: borderlineCfg,
    primary: all.filter((j) => j.status === 'awaiting_approval'),
    shortlisted_pending_tailor: all.filter((j) => j.status === 'shortlisted'),
    borderline_jobs: all.filter((j) => j.status === 'borderline'),
    skipped_recent: all
      .filter((j) => j.status === 'skipped' && j.fit_score != null)
      .slice(0, 20),
    kanban: findExistingCeoReviewKanban(profileId),
  };
}

/** CEO selectively includes borderline (or skipped) jobs → tailor → awaiting_approval → refresh Kanban. */
export async function includeJobsInCeoReview(ceoUserId, profileId, jobIds = []) {
  if (!Array.isArray(jobIds) || jobIds.length === 0) throw new Error('job_ids array required');

  const profileSvc = createJobSearchProfileService(() => getDb());
  const jobsSvc = createJobApplicationsService(() => getDb());
  const sheetSvc = createJobApplicantSpreadsheetService(() => getDb());

  const profile = profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id) throw new Error(`Profile not found: ${profileId}`);

  const included = [];
  for (const jobId of jobIds) {
    const job = jobsSvc.get(jobId);
    if (!job || job.profile_id !== profileId) {
      throw new Error(`Job not found for profile: ${jobId}`);
    }
    if (!['borderline', 'skipped', 'shortlisted'].includes(job.status)) {
      throw new Error(`Job ${jobId} cannot be included (status: ${job.status})`);
    }

    jobsSvc.update(jobId, { status: 'shortlisted', owner_action: 'ceo_include' });

    const result = await tailorResumeForJob({
      ceoUserId,
      profileId,
      jobId,
      syncSpreadsheet: false,
      createKanban: false,
    });
    jobsSvc.update(jobId, {
      status: 'awaiting_approval',
      owner_action: 'ceo_include',
      extra: {
        ceo_included_at: new Date().toISOString(),
        resume_variant_path: result.resume_variant_path,
        resume_drive_link: buildResumeDriveLink(profile, result.job, result.resume_variant_path),
      },
    });
    included.push(jobsSvc.get(jobId));
  }

  const spreadsheet = sheetSvc.syncProfile(ceoUserId, profileId, profile.intake, {
    display_name: profile.display_name,
  });
  const allJobs = jobsSvc.list({ ceo_user_id: ceoUserId, profile_id: profileId, limit: 500 });
  const kanban = createConsolidatedCeoReviewKanban(ceoUserId, profileId, allJobs, profile, spreadsheet);

  return {
    ok: true,
    included_count: included.length,
    included_jobs: included.map((j) => ({
      job_id: j.job_id,
      title: j.title,
      company: j.company,
      fit_score: j.fit_score,
      status: j.status,
    })),
    awaiting_approval_count: allJobs.filter((j) => j.status === 'awaiting_approval').length,
    kanban,
  };
}

/**
 * Phase 1 full flow: tailor all shortlisted jobs → sync spreadsheet → one Kanban CEO review.
 */
export async function runPhase1SubmitCeoReview({
  ceoUserId,
  profileId,
  tailorShortlisted = true,
  jobIds = null,
  workflowRunId = null,
  actor = null,
  skipWorkflowSteps = false,
} = {}) {
  const dbFn = () => getDbForCeo(ceoUserId);
  const profileSvc = createJobSearchProfileService(dbFn);
  const jobsSvc = createJobApplicationsService(dbFn);
  const sheetSvc = createJobApplicantSpreadsheetService(dbFn);

  const pid = profileId || profileSvc.getActiveProfileId(ceoUserId);
  if (!pid) throw new Error('profile_id required');
  const profile = profileSvc.getProfile(ceoUserId, pid);
  if (!profile?.id || profile.status === 'none') {
    throw new Error(`Profile not found: ${pid}`);
  }
  if (profile.status === 'inactive') {
    throw new Error(`Profile "${pid}" is deactivated. Reactivate before submitting for review.`);
  }

  const threshold = Number(profile.intake?.fit_threshold) || 80;

  let toTailor = listJobsNeedingTailor(jobsSvc, ceoUserId, profile.id);
  if (Array.isArray(jobIds) && jobIds.length > 0) {
    toTailor = jobIds.map((id) => jobsSvc.get(id)).filter(Boolean);
  }

  const tailored = tailorShortlisted ? await tailorJobsForReview(ceoUserId, profile.id, toTailor, jobsSvc) : [];

  const spreadsheet = sheetSvc.syncProfile(ceoUserId, profile.id, profile.intake, {
    display_name: profile.display_name,
  });

  const allJobs = jobsSvc.list({
    ceo_user_id: ceoUserId,
    profile_id: profile.id,
    limit: 500,
  });

  const reviewJobs = allJobs.filter(
    (j) =>
      j.status === 'awaiting_approval' ||
      (j.status === 'shortlisted' && Number(j.fit_score) >= threshold)
  );

  const tracker = getJobWorkflowTracker(dbFn);
  const act = actor || { type: 'agent', id: 'resumetailor' };
  let wf = workflowRunId ? tracker.getRun(workflowRunId) : tracker.findActiveRun(ceoUserId, profile.id);
  const workflowMeta = wf
    ? { workflow_id: wf.workflow_id, workflow_number: wf.workflow_number }
    : null;

  const kanban = createConsolidatedCeoReviewKanban(ceoUserId, profile.id, allJobs, profile, spreadsheet, workflowMeta);

  if (!skipWorkflowSteps && wf) {
    tracker.beginStep(wf.workflow_id, 'resume_tailoring', act);
    tracker.completeStep(wf.workflow_id, 'resume_tailoring', act, {
      tailored_count: tailored.filter((t) => !t.skipped).length,
    });
    tracker.completeStep(wf.workflow_id, 'ceo_review', act, {
      kanban_task_id: kanban.kanban_task_id,
      awaiting_approval_count: allJobs.filter((j) => j.status === 'awaiting_approval').length,
    });
    tracker.beginStep(wf.workflow_id, 'ceo_confirm', { type: 'user', id: ceoUserId }, { waiting: 'CEO Kanban confirm' });
    if (kanban.kanban_task_id) tracker.linkKanban(wf.workflow_id, kanban.kanban_task_id);
    wf = tracker.getRun(wf.workflow_id);
  }

  return {
    ok: true,
    workflow_id: wf?.workflow_id,
    workflow_number: wf?.workflow_number,
    ceo_user_id: ceoUserId,
    profile_id: profile.id,
    fit_threshold: threshold,
    tailored_count: tailored.filter((t) => !t.skipped).length,
    awaiting_approval_count: allJobs.filter((j) => j.status === 'awaiting_approval').length,
    review_jobs: reviewJobs.map((j) => ({
      job_id: j.job_id,
      title: j.title,
      company: j.company,
      url: j.url,
      fit_score: j.fit_score,
      resume_drive_link: j.resume_drive_link || buildResumeDriveLink(profile, j, j.resume_variant_path),
    })),
    spreadsheet,
    kanban,
    master_resume_path: profile.intake?.master_resume_path,
    sheet_link: buildSheetLink(profile),
  };
}

/** CEO confirms review — application path (approved + prefill) or scoring-only (acknowledged). */
export async function onCeoReviewAcknowledgedOnly(ceoUserId, profile, acknowledgedJobIds = []) {
  const sheetSvc = createJobApplicantSpreadsheetService(() => getDb());
  const spreadsheet = sheetSvc.syncProfile(ceoUserId, profile.id, profile.intake, {
    display_name: profile.display_name,
  });
  return {
    mode: 'scoring_summary',
    acknowledged_job_ids: acknowledgedJobIds,
    count: acknowledgedJobIds.length,
    spreadsheet,
    message: `Acknowledged ${acknowledgedJobIds.length} job(s) in scoring summary. Workflow complete — no applications for this profile.`,
  };
}

/** CEO confirms review — marks awaiting_approval jobs as approved or acknowledged per profile workflow_goal. */
export async function confirmCeoReview(ceoUserId, profileId, confirm = false, opts = {}) {
  if (!coerceConfirm(confirm)) {
    throw new Error('confirm: true required to proceed');
  }
  if (!profileId) throw new Error('profile_id required');

  const { actor = { type: 'user', id: ceoUserId }, workflow_run_id = null } = opts;
  const dbFn = () => getDbForCeo(ceoUserId);
  const tracker = getJobWorkflowTracker(dbFn);
  const profileSvc = createJobSearchProfileService(dbFn);
  const jobsSvc = createJobApplicationsService(dbFn);
  const profile = profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id || profile.status === 'none') {
    throw new Error(`Profile not found: ${profileId}`);
  }

  const forApplication = requiresJobApplication(profile);
  const goal = normalizeWorkflowGoal(profile.intake?.workflow_goal);

  const pending = jobsSvc.list({
    status: 'awaiting_approval',
    ceo_user_id: ceoUserId,
    profile_id: profile.id,
    limit: 100,
  });

  const processed = [];
  if (forApplication) {
    for (const job of pending) {
      jobsSvc.update(job.job_id, { status: 'approved', owner_action: 'approve' });
      processed.push(job.job_id);
    }
  } else {
    for (const job of pending) {
      jobsSvc.update(job.job_id, { status: 'acknowledged', owner_action: 'acknowledge' });
      processed.push(job.job_id);
    }
  }

  const db = getDb();
  const kanban = findExistingCeoReviewKanban(profile.id);
  if (kanban) {
    db.prepare(`UPDATE kanban_tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?`).run(kanban.id);
  }

  let postApproval = null;
  if (processed.length > 0) {
    postApproval = forApplication
      ? await onCeoReviewApproved(ceoUserId, profile.id, profile)
      : await onCeoReviewAcknowledgedOnly(ceoUserId, profile, processed);
  }

  let wf = workflow_run_id ? tracker.getRun(workflow_run_id) : tracker.findRunAwaitingCeoConfirm(ceoUserId, profile.id);
  if (wf) {
    tracker.completeStep(wf.workflow_id, 'ceo_confirm', actor, {
      jobs_processed: processed.length,
      post_action: forApplication ? 'application' : 'acknowledged',
    });
    if (forApplication && processed.length > 0) {
      tracker.beginStep(wf.workflow_id, 'prefill', { type: 'agent', id: 'applicationagent' });
      tracker.completeStep(
        wf.workflow_id,
        'prefill',
        { type: 'agent', id: 'applicationagent' },
        { prefill_count: postApproval?.prefill?.count ?? processed.length }
      );
      tracker.beginStep(wf.workflow_id, 'application', { type: 'agent', id: 'applicationagent' }, {
        note: 'Application Agent queued',
        kanban_task_id: postApproval?.prefill_kanban?.kanban_task_id,
      });
    } else if (!forApplication) {
      tracker.completeStep(wf.workflow_id, 'acknowledge', actor, { acknowledged_count: processed.length });
      tracker.completeRun(wf.workflow_id, actor, { mode: 'scoring_summary', jobs: processed.length });
    }
    wf = tracker.getRun(wf.workflow_id);
  }

  return {
    ok: true,
    workflow_id: wf?.workflow_id,
    workflow_number: wf?.workflow_number,
    workflow: wf,
    workflow_goal: goal,
    requires_job_application: forApplication,
    post_action: forApplication ? 'application' : 'acknowledged',
    approved_job_ids: forApplication ? processed : [],
    acknowledged_job_ids: forApplication ? [] : processed,
    count: processed.length,
    kanban_task_id: kanban?.id,
    kanban_completed: Boolean(kanban),
    profile_status: profile.status,
    prefill: postApproval?.prefill,
    prefill_kanban: postApproval?.prefill_kanban,
    application_queue: postApproval?.application_queue,
    acknowledgment: forApplication ? undefined : postApproval,
    message:
      processed.length > 0
        ? forApplication
          ? `Approved ${processed.length} job(s). Prefill queued for Application Agent.`
          : postApproval?.message ||
            `Acknowledged ${processed.length} job(s). Scoring summary workflow complete.`
        : kanban
          ? 'Review task closed. No jobs were awaiting approval (they may already be processed).'
          : 'No CEO review task found and no jobs awaiting approval.',
  };
}
