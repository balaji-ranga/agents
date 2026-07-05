/**
 * Application form prefill from resume path + LinkedIn profile + job row.
 * Phase 1: LLM-generated field map stored on job; enqueues Application Agent.
 */
import { chatCompletions } from '../config/llm.js';
import { getDb } from '../db/schema.js';
import { createJobSearchProfileService } from './job-search-profile.js';
import { createJobApplicationsService } from './job-applications.js';
import { enqueueApplicationStageIfNeeded, enqueuePipelineStage, startPipeline } from './job-applicant-pipeline.js';

import { normalizeLinkedInUrl, validateLinkedInProfile } from './job-applicant-intake-normalize.js';
import { requiresJobApplication } from './job-applicant-workflow-goal.js';

function fallbackPrefill(job, profile) {
  const intake = profile.intake || {};
  const linkedin = normalizeLinkedInUrl(intake.linkedin_profile);
  return {
    portal_url: job.url,
    resume_path: job.resume_variant_path || intake.master_resume_path,
    linkedin_profile: linkedin,
    fields: {
      full_name: 'Balaji Muthukrishnan',
      linkedin_url: linkedin,
      current_title: Array.isArray(intake.target_titles) ? intake.target_titles[0] : '',
      location: Array.isArray(intake.locations) ? intake.locations[0] : 'Singapore',
      work_authorization: intake.work_authorization || '',
      cover_letter: job.cover_letter_text || job.why_me_summary || '',
      resume_file: job.resume_variant_path || intake.master_resume_path,
      cover_letter_file: job.cover_letter_path || '',
    },
    notes: `Prefill from tailored resume PDF (${job.resume_variant_path || intake.master_resume_path}) and cover letter (${job.cover_letter_path || 'text only'}). LinkedIn: ${linkedin}. Review before submit per submit_policy: ${intake.submit_policy}.`,
    source: 'fallback',
  };
}

async function generatePrefillPlan(job, profile) {
  const intake = profile.intake || {};
  const linkedin = normalizeLinkedInUrl(intake.linkedin_profile);
  const prompt = `You prepare job application form prefill data. Use ONLY information implied by the profile — never invent employers, degrees, or dates not in the materials.

PROFILE INTAKE:
${JSON.stringify(
  {
    target_titles: intake.target_titles,
    locations: intake.locations,
    work_authorization: intake.work_authorization,
    qa_bank: intake.qa_bank,
    master_resume_path: intake.master_resume_path,
    linkedin_profile: linkedin,
    no_auto_fill_fields: intake.no_auto_fill_fields,
  },
  null,
  2
)}

JOB:
Title: ${job.title}
Company: ${job.company}
URL: ${job.url}
Why me: ${job.why_me_summary || ''}
Tailored resume PDF: ${job.resume_variant_path || intake.master_resume_path}
Cover letter PDF: ${job.cover_letter_path || '(text only)'}

Respond JSON only:
{
  "fields": {
    "full_name": "",
    "email": "",
    "phone": "",
    "linkedin_url": "${linkedin}",
    "current_title": "",
    "years_experience": "",
    "location": "",
    "work_authorization": "",
    "cover_letter": "",
    "resume_file": ""
  },
  "notes": "2-3 sentences for application agent",
  "skip_fields": []
}`;

  try {
    const { content } = await chatCompletions({ messages: [{ role: 'user', content: prompt }], maxTokens: 800 });
    const jsonMatch = (content || '').match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content || '{}');
    if (parsed.fields) {
      parsed.fields.linkedin_url = parsed.fields.linkedin_url || linkedin;
      parsed.fields.resume_file = parsed.fields.resume_file || job.resume_variant_path || intake.master_resume_path;
      parsed.fields.cover_letter_file = job.cover_letter_path || parsed.fields.cover_letter_file || '';
      parsed.portal_url = job.url;
      parsed.resume_path = job.resume_variant_path || intake.master_resume_path;
      parsed.linkedin_profile = linkedin;
      parsed.source = 'llm';
      return parsed;
    }
  } catch (_) {}

  return fallbackPrefill(job, profile);
}

export async function prefillJobApplication(jobId, profile) {
  const jobsSvc = createJobApplicationsService(() => getDb());
  const job = jobsSvc.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (job.status !== 'approved') throw new Error(`Job ${jobId} must be approved before prefill (status: ${job.status})`);

  const linkedinCheck = validateLinkedInProfile(profile.intake?.linkedin_profile);
  if (!linkedinCheck.ok) throw new Error(linkedinCheck.error);

  const plan = await generatePrefillPlan(job, profile);
  plan.linkedin_profile = linkedinCheck.url;
  plan.prefilled_at = new Date().toISOString();

  const updated = jobsSvc.update(jobId, {
    application_notes: plan.notes,
    extra: {
      prefill_fields: plan.fields,
      prefill_plan: plan,
      prefill_status: 'ready',
      linkedin_profile: linkedinCheck.url,
    },
  });

  return { job_id: jobId, prefill: plan, job: updated };
}

export async function runPrefillForApprovedJobs(ceoUserId, profileId, profileOverride = null) {
  const profileSvc = createJobSearchProfileService(() => getDb());
  const jobsSvc = createJobApplicationsService(() => getDb());
  const profile = profileOverride || profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id || profile.status === 'none') {
    throw new Error(`Profile not found: ${profileId}`);
  }
  const linkedinCheck = validateLinkedInProfile(profile.intake?.linkedin_profile);
  if (!linkedinCheck.ok) throw new Error(linkedinCheck.error);

  const approved = jobsSvc.list({
    status: 'approved',
    ceo_user_id: ceoUserId,
    profile_id: profile.id,
    limit: 100,
  });

  const results = [];
  for (const job of approved) {
    try {
      results.push(await prefillJobApplication(job.job_id, profile));
    } catch (e) {
      results.push({ job_id: job.job_id, error: e.message });
    }
  }

  return { ok: true, count: results.length, results, linkedin_profile: linkedinCheck.url };
}

function createPrefillKanbanTask(profile, prefillResults) {
  const db = getDb();
  const lines = [
    `ceo_prefill_profile:${profile.id}`,
    `profile_id: ${profile.id}`,
    '',
    '## Application prefill complete',
    'Forms prepared from **resume** + **LinkedIn profile**. Application Agent will open portals per submit_policy.',
    '',
    `- **LinkedIn:** ${normalizeLinkedInUrl(profile.intake?.linkedin_profile)}`,
    `- **Resume:** ${profile.intake?.master_resume_path}`,
    `- **Jobs prefilled:** ${prefillResults.filter((r) => r.prefill).length}`,
    '',
  ];
  for (const r of prefillResults) {
    if (!r.prefill) {
      lines.push(`- ❌ ${r.job_id}: ${r.error}`);
      continue;
    }
    lines.push(`### ${r.prefill.portal_url || r.job_id}`);
    lines.push(`- **Fields:** ${Object.keys(r.prefill.fields || {}).join(', ')}`);
    lines.push(`- **Notes:** ${r.prefill.notes || '—'}`);
    lines.push('');
  }

  db.prepare(
    `INSERT INTO kanban_tasks (title, description, status, assigned_agent_id, created_by, due_date)
     VALUES (?, ?, 'in_progress', 'applicationagent', 'job_pipeline', NULL)`
  ).run(
    `Application prefill — ${prefillResults.filter((r) => r.prefill).length} job(s)`,
    lines.join('\n')
  );
  const row = db.prepare('SELECT id FROM kanban_tasks ORDER BY id DESC LIMIT 1').get();
  return { kanban_task_id: row?.id };
}

/** After CEO Kanban approval: prefill approved jobs, enqueue application agent (job_application profiles only). */
export async function onCeoReviewApproved(ceoUserId, profileId, profileOverride = null) {
  const profileSvc = createJobSearchProfileService(() => getDb());
  const jobsSvc = createJobApplicationsService(() => getDb());
  const profile = profileOverride || profileSvc.getProfile(ceoUserId, profileId);
  if (!profile?.id || profile.status === 'none') {
    throw new Error(`Profile not found: ${profileId}`);
  }
  if (!requiresJobApplication(profile)) {
    throw new Error(
      `Profile "${profile.id}" is scoring_summary only — use acknowledge flow (job_ceo_review_confirm), not application prefill.`
    );
  }

  const prefill = await runPrefillForApprovedJobs(ceoUserId, profile.id, profile);
  const prefillKanban = createPrefillKanbanTask(profile, prefill.results);

  if (profile.status === 'active') {
    startPipeline(ceoUserId);
  }
  let applicationQueue = null;
  try {
    applicationQueue = enqueueApplicationStageIfNeeded(ceoUserId);
  } catch (_) {}
  if (!applicationQueue?.skipped) {
    try {
      applicationQueue = enqueuePipelineStage(
        'applicationagent',
        `CEO approved ${prefill.count} job(s). Prefill ready from resume + LinkedIn. Fill forms; stop before submit if submit_policy=fill_and_stop.`,
        ceoUserId,
        profileId
      );
    } catch (e) {
      applicationQueue = { error: e.message };
    }
  }

  return {
    prefill,
    prefill_kanban: prefillKanban,
    application_queue: applicationQueue,
    approved_jobs: jobsSvc.list({ status: 'approved', ceo_user_id: ceoUserId, profile_id: profileId, limit: 100 }),
  };
}

export { normalizeLinkedInUrl } from './job-applicant-intake-normalize.js';
