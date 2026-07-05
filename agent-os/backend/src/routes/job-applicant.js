/**
 * Job Applicant pipeline API (status, manual tick, enable/disable).
 */
import { Router } from 'express';
import {
  getPipelineStatus,
  startPipeline,
  stopPipeline,
  runPipelineTick,
  runPipelineTickAll,
  enqueueApplicationStageIfNeeded,
} from '../services/job-applicant-pipeline.js';
import { createJobSearchProfileService } from '../services/job-search-profile.js';
import { createJobApplicantSpreadsheetService, getSpreadsheetPaths } from '../services/job-applicant-spreadsheet.js';
import { runPhase1SubmitCeoReview } from '../services/job-applicant-ceo-review.js';
import { runJobSearchWorkflowNow, runFullJobWorkflow } from '../services/job-applicant-workflow-run.js';
import { processPendingDelegationTasks } from '../services/delegation-queue.js';
import { getJobWorkflowTracker, actorFromRequest } from '../services/job-workflow-tracker.js';
import { confirmCeoReview, getCeoReviewQueue, includeJobsInCeoReview } from '../services/job-applicant-ceo-review.js';
import { getBrowserAuthStatus, markPortalLoggedIn, warmupManagedBrowser, startBrowserLoginFlow, spawnBrowserLoginScript, completeBrowserLogin, assertDiscoveryBrowserReady } from '../services/job-browser-auth.js';
import { connectPortalsForProfile, markProfilePortalsLoggedIn, portalsFromProfileSources } from '../services/portal-connect.js';
import { buildDiscoverySearchUrls, getPortalSearchPatterns } from '../services/job-portal-search-urls.js';
import { harvestJobListingsForProfile } from '../services/job-portal-harvest.js';
import { createJobApplicationsService } from '../services/job-applications.js';
import { getDbForCeo } from '../db/request-db.js';
import { attachAuthUser, resolveCeoDataUserIdFromRequest, requireCeoOrAdmin } from '../middleware/auth.js';
import { existsSync, readFileSync, createReadStream } from 'fs';
import { resolveSafeMaterialPath } from '../services/job-applicant-pdf.js';
import { readMasterResumeText } from '../services/job-applicant-resume.js';
import { resolveMasterResumePath } from '../services/job-candidate-context.js';

const router = Router();

router.use(attachAuthUser);

function ceoFromReq(req, body = null) {
  return resolveCeoDataUserIdFromRequest(req, body ?? req.query ?? req.body ?? {});
}

function profileSvc(ceoUserId) {
  return createJobSearchProfileService(() => getDbForCeo(ceoUserId));
}

function sheetSvc(ceoUserId) {
  return createJobApplicantSpreadsheetService(() => getDbForCeo(ceoUserId));
}

router.get('/profiles', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    res.json(profileSvc(ceoUserId).listProfiles(ceoUserId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/profiles', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profile = profileSvc(ceoUserId).createProfile(ceoUserId, {
      profile_id: req.body?.profile_id,
      display_name: req.body?.display_name,
      patch: req.body?.patch || {},
    });
    res.status(201).json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/profiles/schedules', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const svc = profileSvc(ceoUserId);
    const list = svc.listProfiles(ceoUserId);
    const db = getDbForCeo(ceoUserId);
    const schedules = list.profiles.map((p) => {
      const row = db.prepare('SELECT last_pipeline_run_at, intake_json FROM job_search_profiles WHERE ceo_user_id = ? AND id = ?').get(ceoUserId, p.id);
      let intake = {};
      try {
        intake = JSON.parse(row?.intake_json || '{}');
      } catch (_) {}
      return {
        profile_id: p.id,
        display_name: p.display_name,
        status: p.status,
        is_active: p.is_active,
        workflow_schedule: intake.workflow_schedule || intake.discovery_schedule || 'daily',
        last_pipeline_run_at: row?.last_pipeline_run_at || null,
      };
    });
    res.json({ ceo_user_id: ceoUserId, active_profile_id: list.active_profile_id, profiles: schedules });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/profiles/:profileId', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profile = profileSvc(ceoUserId).getProfile(ceoUserId, req.params.profileId);
    if (!profile?.id) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/profiles/:profileId/discovery-search-urls', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profile = profileSvc(ceoUserId).getProfile(ceoUserId, req.params.profileId);
    if (!profile?.id) return res.status(404).json({ error: 'Profile not found' });
    const intake = profile.intake || {};
    res.json({
      profile_id: profile.id,
      portal_search_patterns: getPortalSearchPatterns(intake),
      urls: buildDiscoverySearchUrls(intake),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/harvest-listings', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profileId = req.params.profileId;
    const gate = profileSvc(ceoUserId).assertActive(ceoUserId, profileId);
    if (!gate.active) return res.status(400).json({ error: gate.error || 'Profile not active' });
    const profile = profileSvc(ceoUserId).getProfile(ceoUserId, gate.profile_id);
    const jobs = createJobApplicationsService(() => getDbForCeo(ceoUserId));
    const result = await harvestJobListingsForProfile(profile.intake || {}, {
      source: req.body?.source,
      max_pages: req.body?.max_pages,
      scroll_steps_per_page: req.body?.scroll_steps_per_page,
      max_listings: req.body?.max_listings,
    });
    const enriched = (result.listings || []).map((row) => {
      const seen = jobs.checkJobSeen(ceoUserId, gate.profile_id, { url: row.url, title: row.title, cross_profile: true });
      return { ...row, block_rediscovery: Boolean(seen.block_rediscovery) };
    });
    res.json({
      ...result,
      profile_id: gate.profile_id,
      listings: enriched,
      new_listings: enriched.filter((r) => !r.block_rediscovery),
      new_count: enriched.filter((r) => !r.block_rediscovery).length,
    });
  } catch (e) {
    res.status(e.login_required ? 503 : 400).json({
      error: e.message,
      login_required: Boolean(e.login_required),
    });
  }
});

router.patch('/profiles/:profileId', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profileId = req.params.profileId;
    const patch = { ...(req.body?.patch || req.body || {}) };
    delete patch.profile_id;
    delete patch.ceo_user_id;
    const profile = profileSvc(ceoUserId).savePatch(ceoUserId, profileId, patch);
    res.json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/confirm', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profile = profileSvc(ceoUserId).confirm(ceoUserId, req.params.profileId, req.body?.confirm, {
      honesty_ack: req.body?.honesty_ack,
    });
    res.json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/jobs/:jobId/materials/:type', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profileId = req.query.profile_id || req.query.profileId;
    const jobId = req.params.jobId;
    const typeRaw = String(req.params.type || '').toLowerCase();
    const type = typeRaw.endsWith('.pdf') ? typeRaw.replace(/\.pdf$/, '') : typeRaw;
    if (!['resume', 'cover-letter'].includes(type)) {
      return res.status(400).json({ error: 'type must be resume.pdf or cover-letter.pdf' });
    }
    if (type === 'resume') {
      if (!profileId) return res.status(400).json({ error: 'profile_id required' });
      const profile = profileSvc(ceoUserId).getProfile(ceoUserId, profileId);
      if (!profile?.id) return res.status(404).json({ error: 'Profile not found' });
      const masterPath = resolveMasterResumePath(profile.intake?.master_resume_path);
      if (!masterPath || !existsSync(masterPath)) {
        return res.status(404).json({ error: 'Master resume not found' });
      }
      const fileName = masterPath.split(/[/\\]/).pop() || 'master-resume.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      createReadStream(masterPath).pipe(res);
      return;
    }
    const filePath = resolveSafeMaterialPath(ceoUserId, profileId, jobId, type);
    if (!filePath) return res.status(404).json({ error: 'Material not found' });
    const fileName = `${jobId}-cover-letter.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    createReadStream(filePath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/master-resume/download', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profileId = req.query.profile_id || profileSvc(ceoUserId).getActiveProfileId(ceoUserId);
    if (!profileId) return res.status(400).json({ error: 'profile_id required' });
    const profile = profileSvc(ceoUserId).getProfile(ceoUserId, profileId);
    if (!profile?.id) return res.status(404).json({ error: 'Profile not found' });
    const masterPath = resolveMasterResumePath(profile.intake?.master_resume_path);
    if (!masterPath || !existsSync(masterPath)) {
      return res.status(404).json({ error: 'Master resume not found' });
    }
    const fileName = masterPath.split(/[/\\]/).pop() || 'master-resume.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    createReadStream(masterPath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/master-resume/preview', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profileId = req.query.profile_id || profileSvc(ceoUserId).getActiveProfileId(ceoUserId);
    if (!profileId) return res.status(400).json({ error: 'profile_id required' });
    const profile = profileSvc(ceoUserId).getProfile(ceoUserId, profileId);
    if (!profile?.id) return res.status(404).json({ error: 'Profile not found' });
    const { masterPath, masterText } = await readMasterResumeText(profile);
    res.json({
      profile_id: profileId,
      master_resume_path: masterPath,
      char_count: masterText.length,
      preview: masterText.slice(0, 2000),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/profiles/:profileId/portal-auth', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profile = profileSvc(ceoUserId).getProfile(ceoUserId, req.params.profileId);
    if (!profile?.id) return res.status(404).json({ error: 'Profile not found' });
    const portals = portalsFromProfileSources(profile.intake?.sources || []);
    res.json({
      profile_id: req.params.profileId,
      ceo_user_id: ceoUserId,
      portal_auth: profile.intake?.portal_auth || {},
      portals,
      global_browser_auth: getBrowserAuthStatus(),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/connect-portals', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const result = await connectPortalsForProfile(ceoUserId, req.params.profileId, {
      portals: req.body?.portals,
      warmup: req.body?.warmup !== false,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/portals/mark-logged-in', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profile = markProfilePortalsLoggedIn(ceoUserId, req.params.profileId, {
      linkedin: req.body?.linkedin,
      jobstreet: req.body?.jobstreet,
      portal_keys: req.body?.portal_keys || [],
    });
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/phase1/submit-review', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profileId = req.body?.profile_id;
    const result = await runPhase1SubmitCeoReview({
      ceoUserId,
      profileId,
      tailorShortlisted: req.body?.tailor_shortlisted !== false,
      jobIds: req.body?.job_ids,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/spreadsheet', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profileId = req.query.profile_id || profileSvc(ceoUserId).getActiveProfileId(ceoUserId);
    if (!profileId) return res.status(400).json({ error: 'profile_id required' });
    const tracker = sheetSvc(ceoUserId).readTracker(ceoUserId, profileId);
    const paths = getSpreadsheetPaths(ceoUserId, profileId);
    let profile_meta = null;
    const metaPath = paths.dir + '/profile-meta.json';
    if (existsSync(metaPath)) {
      try {
        profile_meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch (_) {}
    }
    res.json({ ceo_user_id: ceoUserId, profile_id: profileId, profile_meta, ...tracker });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/spreadsheet/download', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profileId = req.query.profile_id || profileSvc(ceoUserId).getActiveProfileId(ceoUserId);
    if (!profileId) return res.status(400).json({ error: 'profile_id required' });
    const paths = getSpreadsheetPaths(ceoUserId, profileId);
    if (!existsSync(paths.csv_path)) return res.status(404).json({ error: 'Tracker CSV not found. Run job search workflow first.' });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="job-tracker-${profileId}.csv"`);
    res.send(readFileSync(paths.csv_path, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/spreadsheet/summary', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profileId = req.query.profile_id || profileSvc(ceoUserId).getActiveProfileId(ceoUserId);
    if (!profileId) return res.status(400).json({ error: 'profile_id required' });
    const paths = getSpreadsheetPaths(ceoUserId, profileId);
    if (!existsSync(paths.summary_path)) return res.status(404).json({ error: 'Summary not found.' });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(readFileSync(paths.summary_path, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/pipeline/status', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    res.json(getPipelineStatus(ceoUserId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/workflow/run', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const full = req.body?.full !== false && req.body?.sync_only !== true;
    const fn = full ? runFullJobWorkflow : runJobSearchWorkflowNow;
    const result = await fn(ceoUserId, req.body?.profile_id, {
      scoreDiscovered: req.body?.score_discovered !== false,
      submitReview: req.body?.submit_review !== false,
      actor: actorFromRequest(req, ceoUserId),
      workflow_run_id: req.body?.workflow_id || req.body?.workflow_run_id,
      forceDiscovery: req.body?.force_discovery === true,
    });
    if (result?.ok === false && result.login_required) {
      return res.status(401).json(result);
    }
    if (
      result?.ok &&
      ['harvest_server', 'existing_tracker', 'full_async'].includes(result.mode)
    ) {
      try {
        await processPendingDelegationTasks();
      } catch (kickErr) {
        console.warn('[job-applicant] delegation kick after workflow/run:', kickErr.message);
      }
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/workflows', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const profileId = req.query.profile_id;
    if (!profileId) return res.status(400).json({ error: 'profile_id required' });
    const tracker = getJobWorkflowTracker(() => getDbForCeo(ceoUserId));
    res.json({
      ceo_user_id: ceoUserId,
      profile_id: profileId,
      runs: tracker.listRuns(ceoUserId, profileId, { limit: Number(req.query.limit) || 20 }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/workflows/:workflowId', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    const tracker = getJobWorkflowTracker(() => getDbForCeo(ceoUserId));
    const run = tracker.getRun(Number(req.params.workflowId));
    if (!run || run.ceo_user_id !== ceoUserId) {
      return res.status(404).json({ error: 'Workflow run not found' });
    }
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ceo-review/confirm', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const result = await confirmCeoReview(ceoUserId, req.body?.profile_id, req.body?.confirm, {
      actor: actorFromRequest(req, ceoUserId),
      workflow_run_id: req.body?.workflow_id || req.body?.workflow_run_id,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/profiles/:profileId/review-queue', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req);
    res.json(getCeoReviewQueue(ceoUserId, req.params.profileId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/ceo-review/include', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const jobIds = req.body?.job_ids || [];
    const result = await includeJobsInCeoReview(ceoUserId, req.params.profileId, jobIds);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/browser-auth/status', requireCeoOrAdmin, (req, res) => {
  try {
    res.json(getBrowserAuthStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/browser-auth/mark-logged-in', requireCeoOrAdmin, async (req, res) => {
  try {
    res.json(
      markPortalLoggedIn({
        linkedin: req.body?.linkedin,
        jobstreet: req.body?.jobstreet,
        notes: req.body?.notes,
      })
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/browser-auth/complete-login', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    let intake = null;
    const profileId = req.body?.profile_id;
    if (profileId) {
      intake = profileSvc(ceoUserId).getProfile(ceoUserId, profileId)?.intake || null;
    }
    const result = await completeBrowserLogin({
      linkedin: req.body?.linkedin !== false,
      jobstreet: req.body?.jobstreet !== false,
      intake,
      verify: req.body?.verify !== false,
    });
    if (profileId && result.ok) {
      markProfilePortalsLoggedIn(ceoUserId, profileId, {
        linkedin: req.body?.linkedin !== false,
        jobstreet: req.body?.jobstreet !== false,
      });
    }
    if (!result.ready && !result.session_ready) {
      return res.status(400).json({
        error: 'Could not verify portal access. Log in inside the OpenClaw Chromium window, then try Save & connect again.',
        ...result,
      });
    }
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/browser-auth/verify-portals', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profileId = req.body?.profile_id;
    const intake = profileId
      ? profileSvc(ceoUserId).getProfile(ceoUserId, profileId)?.intake || {}
      : {};
    res.json(await assertDiscoveryBrowserReady(intake));
  } catch (e) {
    res.status(e.login_required ? 401 : 502).json({
      error: e.message,
      login_required: Boolean(e.login_required),
      details: e.details,
    });
  }
});

router.post('/browser-auth/warmup', requireCeoOrAdmin, async (req, res) => {
  try {
    res.json(await warmupManagedBrowser());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/browser-auth/start-login', requireCeoOrAdmin, async (req, res) => {
  try {
    const spawnTerminal = req.body?.spawn_terminal === true;
    res.json(await startBrowserLoginFlow({ spawnTerminal }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/browser-auth/spawn-login-script', requireCeoOrAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      ...spawnBrowserLoginScript(),
      note: 'Opens a terminal running node scripts/openclaw-browser-login.js',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/pipeline/start', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const result = await startPipeline(ceoUserId, req.body?.profile_id);
    if (!result.ok && result.login_required) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/pipeline/stop', requireCeoOrAdmin, (req, res) => {
  try {
    res.json(stopPipeline());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/pipeline/tick', requireCeoOrAdmin, async (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const all = req.body?.all === true || req.query?.all === 'true';
    res.json(all ? await runPipelineTickAll() : await runPipelineTick(ceoUserId, req.body?.profile_id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/deactivate', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profileId = req.params.profileId;
    const result = profileSvc(ceoUserId).deactivate(ceoUserId, profileId);
    let pipeline_stopped = false;
    if (result.pipeline_should_stop) {
      stopPipeline();
      pipeline_stopped = true;
    }
    res.json({ ...result, pipeline_stopped });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/delete', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profileId = req.params.profileId;
    const confirm = req.body?.confirm === true || req.body?.confirm === 'true';
    const result = profileSvc(ceoUserId).deleteProfile(ceoUserId, profileId, confirm);
    let pipeline_stopped = false;
    if (result.was_active) {
      stopPipeline();
      pipeline_stopped = true;
    }
    res.json({ ...result, pipeline_stopped });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/profiles/:profileId/rename', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const profileId = req.params.profileId;
    res.json(
      profileSvc(ceoUserId).renameProfile(ceoUserId, profileId, {
        display_name: req.body?.display_name,
        new_profile_id: req.body?.new_profile_id,
      })
    );
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/pipeline/enqueue-applications', requireCeoOrAdmin, (req, res) => {
  try {
    const ceoUserId = ceoFromReq(req, req.body);
    const result = enqueueApplicationStageIfNeeded(ceoUserId);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
