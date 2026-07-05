/**
 * Resolve viewable artifacts (PDFs, images, links, text) for a Kanban task.
 */
import { existsSync } from 'fs';
import { getDb } from '../db/schema.js';
import { getDefaultCeoUserId } from './job-applicant-ceo.js';
import { createJobSearchProfileService } from './job-search-profile.js';
import { createJobApplicationsService } from './job-applications.js';
import { buildJobMaterialLinks, buildTrackerApiLinks, buildMasterResumeLink, isExternalJobPortalUrl } from './job-applicant-links.js';
import { getPipelineState } from './job-applicant-pipeline.js';
import { resolveMasterResumePath } from './job-candidate-context.js';

function toRelativeApiUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('/api/')) return url;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch (_) {
    return url;
  }
}

function makeArtifact({ id, kind, label, url, text, inline = false, group = null, meta = {} }) {
  return {
    id,
    kind,
    label,
    url: url ? toRelativeApiUrl(url) : undefined,
    text: text || undefined,
    inline: !!inline,
    group: group || undefined,
    meta,
  };
}

function parseCeoReviewContext(description) {
  const text = String(description || '');
  const profileMatch = text.match(/ceo_review_profile:([^\s\n]+)/);
  const ceoMatch = text.match(/ceo_user_id:\s*(\S+)/);
  return {
    profileId: profileMatch ? profileMatch[1].trim() : null,
    ceoUserId: ceoMatch ? ceoMatch[1].trim() : getDefaultCeoUserId(),
  };
}

function parsePrefillContext(description) {
  const text = String(description || '');
  const m = text.match(/ceo_prefill_profile:([^\s\n]+)/);
  if (!m) return null;
  const ceoMatch = text.match(/ceo_user_id:\s*(\S+)/);
  return {
    profileId: m[1].trim(),
    ceoUserId: ceoMatch ? ceoMatch[1].trim() : getDefaultCeoUserId(),
  };
}

function parsePipelineContext(prompt, taskDescription = '') {
  const src = `${prompt || ''}\n${taskDescription || ''}`;
  const stage =
    src.match(/\[job_pipeline:(\w+)\]/)?.[1] ||
    src.match(/stage:\s*(\w+)/i)?.[1]?.toLowerCase() ||
    null;
  const ceoUserId = src.match(/ceo_user_id:\s*(\S+)/)?.[1] || getDefaultCeoUserId();
  let profileId = src.match(/profile_id:\s*(\S+)/)?.[1] || null;
  if (profileId === '(active)') profileId = null;
  if (!profileId) {
    const state = getPipelineState();
    profileId = state.active_profile_id || null;
  }
  return { stage, ceoUserId, profileId };
}

function jobMaterialArtifacts(ceoUserId, profileId, job, groupLabel) {
  const group = groupLabel || `${job.title || 'Job'} — ${job.company || 'Unknown'}`;
  const links = buildJobMaterialLinks(ceoUserId, profileId, job.job_id);
  const items = [];

  const hasResume =
    job.materials_ready ||
    job.resume_variant_path ||
    job.resume_pdf_url ||
    (job.status === 'awaiting_approval' && job.why_me_summary);
  if (hasResume) {
    items.push(
      makeArtifact({
        id: `job:${job.job_id}:resume`,
        kind: 'pdf',
        label: 'Master resume PDF (reused)',
        url: job.resume_pdf_url || links.resume_pdf || buildMasterResumeLink(ceoUserId, profileId),
        inline: true,
        group,
        meta: { job_id: job.job_id, company: job.company, title: job.title, fit_score: job.fit_score, uses_master_resume: true },
      })
    );
  }

  const hasCover = job.cover_letter_path || job.cover_letter_pdf_url;
  if (hasCover) {
    items.push(
      makeArtifact({
        id: `job:${job.job_id}:cover`,
        kind: 'pdf',
        label: 'Cover letter PDF',
        url: job.cover_letter_pdf_url || links.cover_letter_pdf,
        inline: true,
        group,
        meta: { job_id: job.job_id, company: job.company, title: job.title },
      })
    );
  }

  if (job.url && isExternalJobPortalUrl(job.url)) {
    items.push(
      makeArtifact({
        id: `job:${job.job_id}:portal`,
        kind: 'link',
        label: 'Job portal',
        url: job.url,
        group,
        meta: { job_id: job.job_id },
      })
    );
  }

  if (job.why_me_summary) {
    items.push(
      makeArtifact({
        id: `job:${job.job_id}:why_me`,
        kind: 'text',
        label: 'Why me (CEO review)',
        text: String(job.why_me_summary),
        group,
        meta: { job_id: job.job_id },
      })
    );
  }

  if (job.tailoring_notes) {
    items.push(
      makeArtifact({
        id: `job:${job.job_id}:notes`,
        kind: 'text',
        label: 'Tailoring notes',
        text: String(job.tailoring_notes),
        group,
        meta: { job_id: job.job_id },
      })
    );
  }

  if (job.fit_score != null && job.fit_rationale) {
    items.push(
      makeArtifact({
        id: `job:${job.job_id}:fit`,
        kind: 'text',
        label: `Fit score ${job.fit_score}%`,
        text: String(job.fit_rationale),
        group,
        meta: { job_id: job.job_id, fit_score: job.fit_score },
      })
    );
  }

  return items;
}

function profileTrackerArtifacts(ceoUserId, profileId, group = 'Profile') {
  const tracker = buildTrackerApiLinks(ceoUserId, profileId);
  return [
    makeArtifact({
      id: `profile:${profileId}:tracker-csv`,
      kind: 'csv',
      label: 'Job tracker CSV',
      url: tracker.csv_download,
      group,
      meta: { profile_id: profileId },
    }),
    makeArtifact({
      id: `profile:${profileId}:tracker-summary`,
      kind: 'link',
      label: 'Matches summary (JSON)',
      url: tracker.summary_view,
      group,
      meta: { profile_id: profileId },
    }),
  ];
}

function masterResumeArtifact(profile, group = 'Profile') {
  const masterPath = resolveMasterResumePath(profile.intake?.master_resume_path);
  if (!masterPath || !existsSync(masterPath)) return null;
  const q = new URLSearchParams({
    profile_id: profile.id,
    ceo_user_id: profile.ceo_user_id || getDefaultCeoUserId(),
  });
  return makeArtifact({
    id: `profile:${profile.id}:master-resume`,
    kind: 'pdf',
    label: 'Master resume PDF',
    url: `/api/job-applicant/master-resume/download?${q}`,
    inline: true,
    group,
    meta: { profile_id: profile.id },
  });
}

function extractUrlsFromText(text, sourceId = 'text') {
  if (!text) return [];
  const items = [];
  const seen = new Set();
  const urlRe = /(https?:\/\/[^\s<>"')\]]+|\/api\/[^\s<>"')\]]+|sandbox:\/(?:api\/media\/|media\/)[^\s<>"')\]]+)/gi;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const raw = m[1].replace(/[.,;:!?)]+$/, '');
    if (seen.has(raw)) continue;
    if (raw.startsWith('http://127.0.0.1') || raw.startsWith('http://localhost')) continue;
    seen.add(raw);

    let kind = 'link';
    let inline = false;
    const lower = raw.toLowerCase();
    if (/\.pdf(\?|$)/i.test(lower)) {
      kind = 'pdf';
      inline = true;
    } else if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(lower) || lower.includes('/media/')) {
      kind = 'image';
      inline = true;
    } else if (/\.(csv)(\?|$)/i.test(lower) || lower.includes('spreadsheet/download')) {
      kind = 'csv';
    }

    let url = raw;
    if (url.startsWith('sandbox:/api/media/')) {
      url = url.slice('sandbox:'.length);
    } else if (url.startsWith('sandbox:/media/')) {
      url = `/api/media/openclaw/${url.slice('sandbox:/media/'.length)}`;
    } else if (url.startsWith('/media/')) {
      url = `/api/media/openclaw/${url.slice('/media/'.length)}`;
    }

    items.push(
      makeArtifact({
        id: `${sourceId}:url:${items.length}`,
        kind,
        label: kind === 'pdf' ? 'PDF' : kind === 'image' ? 'Image' : 'Link',
        url: toRelativeApiUrl(url),
        inline,
        group: 'From task content',
      })
    );
  }
  return items;
}

function artifactsForCeoReview(description) {
  const { profileId, ceoUserId } = parseCeoReviewContext(description);
  if (!profileId) return [];

  const profileSvc = createJobSearchProfileService(() => getDb());
  const jobsSvc = createJobApplicationsService(() => getDb());
  const profile = profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id) return [];

  const all = jobsSvc.list({ ceo_user_id: ceoUserId, profile_id: profileId, limit: 500 });
  const reviewJobs = all.filter((j) =>
    ['awaiting_approval', 'shortlisted', 'resume_ready'].includes(j.status)
  );

  const items = [];
  for (const job of reviewJobs) {
    items.push(...jobMaterialArtifacts(ceoUserId, profileId, job));
  }
  items.push(...profileTrackerArtifacts(ceoUserId, profileId));
  const master = masterResumeArtifact(profile);
  if (master) items.push(master);
  return items;
}

function artifactsForPipelineStage(stage, ceoUserId, profileId, taskCreatedAt, taskDescription = '') {
  if (!stage || !profileId) return [];

  const profileSvc = createJobSearchProfileService(() => getDb());
  const jobsSvc = createJobApplicationsService(() => getDb());
  const profile = profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id) return [];

  const all = jobsSvc.list({ ceo_user_id: ceoUserId, profile_id: profileId, limit: 500 });
  const isWorkflowTask = /workflow_id:\s*\d+/.test(String(taskDescription || ''));
  const since = !isWorkflowTask && taskCreatedAt ? new Date(taskCreatedAt).getTime() - 10 * 60 * 1000 : 0;
  const recent = (j) => !since || new Date(j.updated_at || 0).getTime() >= since;

  const items = [];

  if (stage === 'resumetailor') {
    const jobs = all.filter(
      (j) =>
        (isWorkflowTask || recent(j)) &&
        (j.materials_ready ||
          j.resume_variant_path ||
          ['awaiting_approval', 'shortlisted'].includes(j.status))
    );
    for (const job of jobs) {
      items.push(...jobMaterialArtifacts(ceoUserId, profileId, job, `Tailored — ${job.company}`));
    }
    items.push(...profileTrackerArtifacts(ceoUserId, profileId, 'Resume tailoring'));
  } else if (stage === 'fitscorer') {
    const jobs = all.filter(
      (j) => (isWorkflowTask || recent(j)) && j.fit_score != null && j.status !== 'discovered'
    );
    for (const job of jobs.slice(0, 30)) {
      items.push(...jobMaterialArtifacts(ceoUserId, profileId, job, `Scored — ${job.company}`));
    }
    items.push(...profileTrackerArtifacts(ceoUserId, profileId, 'Fit scoring'));
  } else if (stage === 'discovery') {
    const jobs = all.filter((j) => recent(j) && j.status === 'discovered');
    for (const job of jobs.slice(0, 30)) {
      if (job.url) {
        items.push(
          makeArtifact({
            id: `discovered:${job.job_id}`,
            kind: 'link',
            label: `${job.title || 'Job'} — ${job.company || 'Unknown'}`,
            url: job.url,
            group: 'Discovered jobs',
            meta: { job_id: job.job_id, source: job.source },
          })
        );
      }
    }
    items.push(...profileTrackerArtifacts(ceoUserId, profileId, 'Discovery'));
  } else if (stage === 'applicationagent') {
    const jobs = all.filter((j) => ['approved', 'applied', 'failed'].includes(j.status) && recent(j));
    for (const job of jobs) {
      items.push(...jobMaterialArtifacts(ceoUserId, profileId, job, `Application — ${job.company}`));
    }
  }

  const master = masterResumeArtifact(profile, stage);
  if (master) items.push(master);
  return items;
}

function artifactsForPrefill(description) {
  const ctx = parsePrefillContext(description);
  if (!ctx) return [];

  const items = [];
  const blocks = String(description).split(/^### /m).slice(1);
  for (const block of blocks) {
    const titleLine = block.split('\n')[0]?.trim();
    const portalMatch = block.match(/portal[^\n]*?(https?:\/\/[^\s\n]+)/i);
    const url = portalMatch?.[1] || (titleLine?.startsWith('http') ? titleLine : null);
    if (url) {
      items.push(
        makeArtifact({
          id: `prefill:${url}`,
          kind: 'link',
          label: titleLine || 'Application portal',
          url,
          group: 'Prefill portals',
        })
      );
    }
  }

  items.push(...profileTrackerArtifacts(ctx.ceoUserId, ctx.profileId, 'Prefill'));
  return items;
}

/**
 * @param {object} task — kanban_tasks row
 * @param {{ prompt?: string, response_content?: string } | null} delegation
 * @param {Array<{ role: string, content: string }>} messages
 */
export function resolveKanbanTaskArtifacts(task, delegation = null, messages = []) {
  const desc = task?.description || '';
  const buckets = [];

  if (desc.includes('ceo_review_profile:')) {
    buckets.push(...artifactsForCeoReview(desc));
  }

  const prefill = artifactsForPrefill(desc);
  if (prefill.length) buckets.push(...prefill);

  const pipelineCtx = parsePipelineContext(delegation?.prompt, desc);
  if (pipelineCtx.stage) {
    buckets.push(
      ...artifactsForPipelineStage(
        pipelineCtx.stage,
        pipelineCtx.ceoUserId,
        pipelineCtx.profileId,
        task?.created_at,
        desc
      )
    );
  }

  buckets.push(...extractUrlsFromText(desc, 'desc'));
  if (delegation?.prompt) buckets.push(...extractUrlsFromText(delegation.prompt, 'delegation-prompt'));
  if (delegation?.response_content) {
    buckets.push(...extractUrlsFromText(delegation.response_content, 'delegation-response'));
  }
  for (const msg of messages || []) {
    buckets.push(...extractUrlsFromText(msg.content, `msg-${msg.id || msg.role}`));
  }

  const seen = new Set();
  const artifacts = [];
  for (const a of buckets) {
    if (!a?.id || seen.has(a.id)) continue;
    seen.add(a.id);
    artifacts.push(a);
  }

  const groups = [...new Set(artifacts.map((a) => a.group).filter(Boolean))];
  return { artifacts, groups, count: artifacts.length };
}
