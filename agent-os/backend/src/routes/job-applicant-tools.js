/**

 * Job Applicant tool routes — mounted under /api/tools.

 */

import { Router } from 'express';

import { getDb } from '../db/schema.js';
import { getDbForCeo } from '../db/request-db.js';

import { chatCompletions } from '../config/llm.js';

import { createJobSearchProfileService, coerceConfirm } from '../services/job-search-profile.js';

import { createJobApplicationsService } from '../services/job-applications.js';

import { resolveCeoUserId, resolveCeoDataUserId } from '../services/job-applicant-ceo.js';

import { startPipeline, stopPipeline, enqueueApplicationStageIfNeeded } from '../services/job-applicant-pipeline.js';

import { createJobApplicantSpreadsheetService } from '../services/job-applicant-spreadsheet.js';

import { tailorResumeForJob, readMasterResumeText } from '../services/job-applicant-resume.js';

import { runPhase1SubmitCeoReview, confirmCeoReview, includeJobsInCeoReview } from '../services/job-applicant-ceo-review.js';
import { scoreJobForProfile } from '../services/job-applicant-fit-score.js';
import { runFullJobWorkflow, runJobPipelineStart } from '../services/job-applicant-workflow-run.js';
import { getJobWorkflowTracker, actorFromRequest } from '../services/job-workflow-tracker.js';
import { harvestJobListingsForProfile } from '../services/job-portal-harvest.js';

const router = Router();

function profileService(ceoUserId) {
  return createJobSearchProfileService(() => getDbForCeo(ceoUserId));
}

function jobsService(ceoUserId) {
  return createJobApplicationsService(() => getDbForCeo(ceoUserId));
}

function spreadsheetService(ceoUserId) {
  return createJobApplicantSpreadsheetService(() => getDbForCeo(ceoUserId));
}



async function syncSpreadsheetForProfile(ceoUserId, profileId) {

  const profile = profileService(ceoUserId).getProfile(ceoUserId, profileId);

  if (!profile?.id) return null;

  return spreadsheetService(ceoUserId).syncProfile(ceoUserId, profile.id, profile.intake);

}



function ctx(req, body = {}) {

  const b = body && typeof body === 'object' ? body : {};

  const ceoUserId = resolveCeoDataUserId(
    b.ceo_user_id ?? b.ceoUserId ?? resolveCeoUserId(req, b)
  );
  const profileId = b.profile_id || b.profileId || null;

  return { ceoUserId, profileId };

}



async function logTool(req, res, _toolName, handler) {

  try {

    const data = await handler();

    res.json(data);

  } catch (err) {

    const status = err.status || 400;

    res.status(status).json({ error: err.message || String(err) });

  }

}



router.post('/job-search-profile-list', (req, res) => {

  logTool(req, res, 'job_search_profile_list', async () => {

    const { ceoUserId } = ctx(req, req.body);

    return profileService(ceoUserId).listProfiles(ceoUserId);

  });

});



router.post('/job-search-profile-create', (req, res) => {

  logTool(req, res, 'job_search_profile_create', async () => {

    const { ceoUserId } = ctx(req, req.body);

    const body = req.body || {};

    return profileService(ceoUserId).createProfile(ceoUserId, {

      profile_id: body.profile_id || body.profileId,

      display_name: body.display_name || body.displayName,

      patch: body.patch || {},

    });

  });

});



router.post('/job-search-profile-set-active', (req, res) => {

  logTool(req, res, 'job_search_profile_set_active', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const pid = profileId || req.body?.profile_id;

    if (!pid) throw new Error('profile_id required');

    return profileService(ceoUserId).setActiveProfile(ceoUserId, pid);

  });

});



router.post('/job-search-profile-deactivate', (req, res) => {

  logTool(req, res, 'job_search_profile_deactivate', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const pid = profileId || req.body?.profile_id;

    const result = profileService(ceoUserId).deactivate(ceoUserId, pid);

    let pipeline_stopped = false;

    if (result.pipeline_should_stop) {

      stopPipeline();

      pipeline_stopped = true;

    }

    return { ...result, pipeline_stopped };

  });

});



router.post('/job-search-profile-rename', (req, res) => {

  logTool(req, res, 'job_search_profile_rename', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const pid = profileId || req.body?.profile_id;

    return profileService(ceoUserId).renameProfile(ceoUserId, pid, {

      display_name: req.body?.display_name || req.body?.new_display_name,

      new_profile_id: req.body?.new_profile_id,

    });

  });

});



router.post('/job-search-profile-delete', (req, res) => {

  logTool(req, res, 'job_search_profile_delete', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const pid = profileId || req.body?.profile_id;

    const confirm = coerceConfirm(req.body?.confirm);

    const result = profileService(ceoUserId).deleteProfile(ceoUserId, pid, confirm);

    let pipeline_stopped = false;

    if (result.was_active) {

      stopPipeline();

      pipeline_stopped = true;

    }

    return { ...result, pipeline_stopped };

  });

});



router.post('/job-search-profile-get', (req, res) => {

  logTool(req, res, 'job_search_profile_get', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    return profileService(ceoUserId).getProfile(ceoUserId, profileId);

  });

});



router.post('/job-search-profile-save', (req, res) => {

  logTool(req, res, 'job_search_profile_save', async () => {

    const body = req.body || {};

    const patch = body.patch && typeof body.patch === 'object' ? body.patch : { ...body };

    delete patch.tool_name;

    delete patch.toolName;

    delete patch.confirm;

    delete patch.patch;

    delete patch.ceo_user_id;

    delete patch.profile_id;

    const { ceoUserId, profileId } = ctx(req, body);

    return profileService(ceoUserId).savePatch(ceoUserId, profileId, patch);

  });

});



router.post('/job-search-profile-intake-status', (req, res) => {

  logTool(req, res, 'job_search_profile_intake_status', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const p = profileService(ceoUserId).getProfile(ceoUserId, profileId);

    return {

      ceo_user_id: ceoUserId,

      profile_id: p.id,

      status: p.status,

      complete: p.intake_complete,

      missing_fields: p.missing_fields,

      is_active: p.is_active,

    };

  });

});



router.post('/job-search-profile-confirm', (req, res) => {

  logTool(req, res, 'job_search_profile_confirm', async () => {

    const body = req.body || {};

    const confirm = coerceConfirm(body.confirm);

    const { ceoUserId, profileId } = ctx(req, body);

    const profile = profileService(ceoUserId).confirm(ceoUserId, profileId, confirm, {

      honesty_ack: body.honesty_ack,

    });

    const pipeline = startPipeline(ceoUserId);

    return { ...profile, pipeline_started: pipeline };

  });

});



router.post('/job-check-profile-active', (req, res) => {

  logTool(req, res, 'job_check_profile_active', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const result = profileService(ceoUserId).assertActive(ceoUserId, profileId);

    if (!result.active) {

      const err = new Error(result.error);

      err.status = 403;

      throw err;

    }

    return {

      active: true,

      status: result.profile.status,

      ceo_user_id: ceoUserId,

      profile_id: result.profile_id,

    };

  });

});



router.post('/jobs-list', (req, res) => {

  logTool(req, res, 'jobs_list', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);

    const activeProfileId = gate.active ? gate.profile_id : profileId || profileService(ceoUserId).getActiveProfileId(ceoUserId);

    const jobs = jobsService(ceoUserId).list({

      status: req.body?.status,

      owner_action: req.body?.owner_action,

      limit: req.body?.limit,

      ceo_user_id: ceoUserId,

      profile_id: req.body?.profile_id || activeProfileId,

    });

    return { jobs, count: jobs.length, ceo_user_id: ceoUserId, profile_id: activeProfileId };

  });

});



router.post('/job-check-url-seen', (req, res) => {

  logTool(req, res, 'job_check_url_seen', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const pid = profileId || profileService(ceoUserId).getActiveProfileId(ceoUserId);

    if (!pid) throw new Error('profile_id required');

    const crossProfile = req.body?.cross_profile !== false;

    if (Array.isArray(req.body?.jobs) && req.body.jobs.length > 0) {

      const results = req.body.jobs.map((j) =>

        jobsService(ceoUserId).checkJobSeen(ceoUserId, pid, {

          url: j.url,

          company: j.company,

          title: j.title,

          job_id: j.job_id,

          cross_profile: crossProfile,

        })

      );

      return {

        ceo_user_id: ceoUserId,

        profile_id: pid,

        results,

        block_count: results.filter((r) => r.block_rediscovery).length,

        new_count: results.filter((r) => !r.seen).length,

      };

    }

    return jobsService(ceoUserId).checkJobSeen(ceoUserId, pid, {

      url: req.body?.url,

      company: req.body?.company,

      title: req.body?.title,

      job_id: req.body?.job_id,

      cross_profile: crossProfile,

    });

  });

});



router.post('/job-inventory-summary', (req, res) => {

  logTool(req, res, 'job_inventory_summary', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const pid = req.body?.all_profiles ? null : profileId || profileService(ceoUserId).getActiveProfileId(ceoUserId);

    return jobsService(ceoUserId).inventorySummary(ceoUserId, pid);

  });

});



router.post('/jobs-append', (req, res) => {

  logTool(req, res, 'jobs_append', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);

    if (!gate.active) {

      const err = new Error(gate.error);

      err.status = 403;

      throw err;

    }

    const jobs = req.body?.jobs || (Array.isArray(req.body) ? req.body : []);

    const result = jobsService(ceoUserId).append(jobs, {

      profile_id: gate.profile_id,

      ceo_user_id: ceoUserId,

      skip_if_seen: req.body?.skip_if_seen !== false,

      cross_profile: req.body?.cross_profile !== false,

    });

    await syncSpreadsheetForProfile(ceoUserId, gate.profile_id);

    const tracker = getJobWorkflowTracker(() => getDbForCeo(ceoUserId));
    const actor = actorFromRequest(req);
    const profile = profileService(ceoUserId).getProfile(ceoUserId, gate.profile_id);
    let wf = tracker.findActiveRun(ceoUserId, gate.profile_id);
    if (wf) {
      const disc = wf.steps?.find((s) => s.step_key === 'job_discovery');
      if (disc?.status === 'completed') wf = null;
    }
    if (!wf && result.count_added > 0) {
      tracker.supersedeRunningRuns(ceoUserId, gate.profile_id, actor, {
        trigger: 'jobs_append',
        reason: 'new_discovery_batch',
      });
      wf = tracker.startRun({
        ceoUserId,
        profileId: gate.profile_id,
        workflowGoal: profile?.intake?.workflow_goal,
        trigger: 'jobs_append',
        actor,
        metadata: { jobs_appended: result.count_added },
      });
      getDbForCeo(ceoUserId)
        .prepare(
          `UPDATE job_pipeline_state SET active_workflow_run_id = ?, updated_at = datetime('now') WHERE id = 1`
        )
        .run(wf.workflow_id);
    }
    if (wf && result.count_added > 0) {
      tracker.beginStep(wf.workflow_id, 'job_discovery', actor);
      tracker.completeStep(wf.workflow_id, 'job_discovery', actor, {
        jobs_appended: result.count_added,
        jobs_skipped_seen: result.count_skipped_seen,
      });
      wf = tracker.getRun(wf.workflow_id);
    }

    return {
      ...result,
      profile_id: gate.profile_id,
      workflow_id: wf?.workflow_id,
      workflow_number: wf?.workflow_number,
      next_step:
        result.count_added > 0
          ? `Call job_run_workflow_now with profile_id "${gate.profile_id}" (workflow #${wf?.workflow_number || 'new'}) to score jobs, tailor resumes, and create the Kanban CEO review task.`
          : result.count_skipped_seen > 0
            ? 'All jobs were already in inventory (applied/skipped/in pipeline). Run discovery for new URLs only.'
            : undefined,
    };

  });

});



router.post('/jobs-update', (req, res) => {

  logTool(req, res, 'jobs_update', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);

    if (!gate.active) {

      const err = new Error(gate.error);

      err.status = 403;

      throw err;

    }

    const jobId = req.body?.job_id;

    const patch = req.body?.patch || {};

    const updated = jobsService(ceoUserId).update(jobId, patch);

    if (patch.status === 'approved' || patch.owner_action === 'approve') {

      try {

        enqueueApplicationStageIfNeeded(ceoUserId);

      } catch (_) {}

    }

    await syncSpreadsheetForProfile(ceoUserId, gate.profile_id);

    return updated;

  });

});



router.post('/job-fit-score', async (req, res) => {
  try {
    const { ceoUserId, profileId } = ctx(req, req.body || {});
    const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);
    if (!gate.active) return res.status(403).json({ error: gate.error });

    const profile = gate.profile;
    const jobs = jobsService(ceoUserId);
    let job = null;
    if (req.body?.job_id) {
      job = jobs.get(req.body.job_id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
    } else {
      job = {
        title: req.body?.title,
        company: req.body?.company,
        url: req.body?.url,
        location: req.body?.location,
        source: req.body?.source,
      };
    }

    const result = await scoreJobForProfile({
      profile,
      job,
      jobDescription: req.body?.job_description || req.body?.description || '',
      jobsSvc: jobs,
      updateRow: Boolean(job?.job_id),
    });
    res.json({ ...result, ceo_user_id: ceoUserId, profile_id: gate.profile_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



router.post('/job-tailor-resume', async (req, res) => {

  try {

    const { ceoUserId, profileId } = ctx(req, req.body || {});

    const jobId = req.body?.job_id;

    if (!jobId) return res.status(400).json({ error: 'job_id required' });

    const result = await tailorResumeForJob({

      ceoUserId,

      profileId,

      jobId,

      syncSpreadsheet: req.body?.sync_spreadsheet !== false,

      createKanban: req.body?.create_kanban === true,

    });

    res.json(result);

  } catch (e) {

    res.status(e.message?.includes('not active') ? 403 : 400).json({ error: e.message });

  }

});

router.post('/job-read-master-resume', async (req, res) => {
  try {
    const { ceoUserId, profileId } = ctx(req, req.body || {});
    const profileSvc = createJobSearchProfileService(() => getDbForCeo(ceoUserId));
    const gate = profileSvc.assertActive(ceoUserId, profileId);
    if (!gate.active) return res.status(403).json({ error: gate.error });
    const { masterPath, masterText } = await readMasterResumeText(gate.profile);
    res.json({
      ok: true,
      profile_id: gate.profile.id,
      master_resume_path: masterPath,
      char_count: masterText.length,
      preview: masterText.slice(0, 1500),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});



router.post('/job-spreadsheet-sync', (req, res) => {

  logTool(req, res, 'job_spreadsheet_sync', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);

    const pid = gate.active ? gate.profile_id : profileId || profileService(ceoUserId).getActiveProfileId(ceoUserId);

    if (!pid) throw new Error('profile_id required');

    const profile = profileService(ceoUserId).getProfile(ceoUserId, pid);

    return spreadsheetService(ceoUserId).syncProfile(ceoUserId, pid, profile.intake);

  });

});



router.post('/job-spreadsheet-get', (req, res) => {

  logTool(req, res, 'job_spreadsheet_get', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const pid = profileId || profileService(ceoUserId).getActiveProfileId(ceoUserId);

    if (!pid) throw new Error('profile_id required');

    const tracker = spreadsheetService(ceoUserId).readTracker(ceoUserId, pid);

    return { ceo_user_id: ceoUserId, profile_id: pid, ...tracker };

  });

});



router.post('/job-phase1-submit-ceo-review', async (req, res) => {

  try {

    const { ceoUserId, profileId } = ctx(req, req.body || {});

    const result = await runPhase1SubmitCeoReview({

      ceoUserId,

      profileId,

      tailorShortlisted: req.body?.tailor_shortlisted !== false,

      jobIds: req.body?.job_ids,

    });

    res.json(result);

  } catch (e) {

    res.status(e.message?.includes('not active') ? 403 : 400).json({ error: e.message });

  }

});



router.post('/job-ceo-review-confirm', async (req, res) => {

  logTool(req, res, 'job_ceo_review_confirm', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const confirm = req.body?.confirm === true || req.body?.confirm === 'true' || req.body?.confirm === 'yes';

    return confirmCeoReview(ceoUserId, profileId, confirm, {
      actor: actorFromRequest(req, ceoUserId),
      workflow_run_id: req.body?.workflow_id || req.body?.workflow_run_id,
    });

  });

});



router.post('/job-ceo-review-include', async (req, res) => {

  logTool(req, res, 'job_ceo_review_include', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const jobIds = req.body?.job_ids || [];

    return includeJobsInCeoReview(ceoUserId, profileId, jobIds);

  });

});



router.post('/job-run-workflow-now', async (req, res) => {

  logTool(req, res, 'job_run_workflow_now', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    return runFullJobWorkflow(ceoUserId, profileId, {

      scoreDiscovered: req.body?.score_discovered !== false,

      submitReview: req.body?.submit_review !== false,

      tailorShortlisted: req.body?.tailor_shortlisted !== false,

      actor: actorFromRequest(req, ceoUserId),

      workflow_run_id: req.body?.workflow_id || req.body?.workflow_run_id,

      forceDiscovery: req.body?.force_discovery === true,

    });

  });

});



router.post('/job-pipeline-start', (req, res) => {

  logTool(req, res, 'job_pipeline_start', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    return runJobPipelineStart(ceoUserId, profileId);

  });

});



router.post('/job-workflow-list', (req, res) => {

  logTool(req, res, 'job_workflow_list', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    if (!profileId) throw new Error('profile_id required');

    const tracker = getJobWorkflowTracker(() => getDbForCeo(ceoUserId));

    return {

      ceo_user_id: ceoUserId,

      profile_id: profileId,

      runs: tracker.listRuns(ceoUserId, profileId, { limit: req.body?.limit || 20 }),

    };

  });

});



router.post('/job-workflow-get', (req, res) => {

  logTool(req, res, 'job_workflow_get', async () => {

    const { ceoUserId, profileId } = ctx(req, req.body);

    const tracker = getJobWorkflowTracker(() => getDbForCeo(ceoUserId));

    const workflowId = req.body?.workflow_id || req.body?.workflow_run_id;

    const workflowNumber = req.body?.workflow_number;

    let run = null;

    if (workflowId) {

      run = tracker.getRun(Number(workflowId));

      if (run && run.ceo_user_id !== ceoUserId) run = null;

    } else if (profileId && workflowNumber != null) {

      run = tracker.getRunByNumber(ceoUserId, profileId, Number(workflowNumber));

    } else if (profileId) {

      run = tracker.findActiveRun(ceoUserId, profileId);

    }

    if (!run) throw new Error('Workflow run not found');

    return run;

  });

});



router.post('/job-portal-harvest-listings', async (req, res) => {
  logTool(req, res, 'job_portal_harvest_listings', async () => {
    const { ceoUserId, profileId } = ctx(req, req.body);
    const gate = profileService(ceoUserId).assertActive(ceoUserId, profileId);
    if (!gate.active) {
      const err = new Error(gate.error || 'Profile not active');
      err.status = 400;
      throw err;
    }
    const profile = profileService(ceoUserId).getProfile(ceoUserId, gate.profile_id);
    const intake = profile?.intake || {};
    const jobs = jobsService(ceoUserId);

    const result = await harvestJobListingsForProfile(intake, {
      source: req.body?.source,
      max_pages: req.body?.max_pages != null ? Number(req.body.max_pages) : undefined,
      scroll_steps_per_page:
        req.body?.scroll_steps_per_page != null ? Number(req.body.scroll_steps_per_page) : undefined,
      max_listings: req.body?.max_listings != null ? Number(req.body.max_listings) : undefined,
    });

    const enriched = (result.listings || []).map((row) => {
      const seen = jobs.checkJobSeen(ceoUserId, gate.profile_id, {
        url: row.url,
        title: row.title,
        cross_profile: true,
      });
      return {
        ...row,
        block_rediscovery: Boolean(seen.block_rediscovery),
        seen: Boolean(seen.seen),
      };
    });

    const newListings = enriched.filter((r) => !r.block_rediscovery);

    return {
      ok: result.ok,
      profile_id: gate.profile_id,
      ceo_user_id: ceoUserId,
      count: enriched.length,
      new_count: newListings.length,
      listings: enriched,
      new_listings: newListings,
      by_source: result.by_source,
      runs: result.runs,
      hint: result.hint,
    };
  });
});



export default router;


