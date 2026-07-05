/**
 * Resume tailoring: reuse master resume PDF; generate cover letter PDF only.
 * Sets awaiting_approval for CEO Kanban review before Application Agent submits.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { chatCompletions } from '../config/llm.js';
import { getDbForCeo } from '../db/request-db.js';
import { createJobSearchProfileService } from './job-search-profile.js';
import { createJobApplicationsService } from './job-applications.js';
import { createJobApplicantSpreadsheetService } from './job-applicant-spreadsheet.js';
import { resolveMasterResumePath } from './job-candidate-context.js';
import { materialsRoot, extractPdfText, writeCoverLetterPdf } from './job-applicant-pdf.js';
import { buildJobMaterialLinks } from './job-applicant-links.js';

function fallbackTailoring(job, profile) {
  const titles = Array.isArray(profile.intake?.target_titles)
    ? profile.intake.target_titles.join(', ')
    : 'target role';
  const name = profile.display_name || profile.intake?.candidate_name || 'Candidate';
  return {
    why_me_summary: `Strong fit for ${job.title} at ${job.company}: experience aligns with ${titles}. ${job.fit_rationale || ''}`.trim(),
    tailoring_notes: `Master resume reused unchanged. Cover letter emphasizes ${titles} for this role.`,
    cover_letter_text: `Dear Hiring Team,\n\nI am applying for the ${job.title} role at ${job.company}. My background in ${titles} maps directly to your requirements.\n\n${job.fit_rationale || 'I would welcome a conversation.'}`,
    candidate_name: name,
  };
}

async function generateTailoringContent(job, profile, masterText) {
  const intakeSummary = JSON.stringify(profile.intake, null, 2).slice(0, 5000);
  const masterExcerpt = (masterText || '').slice(0, 12000);
  const name = profile.display_name || profile.intake?.candidate_name || 'Candidate';

  const prompt = `You write job application cover letters. The candidate's master resume PDF is reused unchanged — do NOT rewrite or invent resume content.

CANDIDATE NAME: ${name}

PROFILE INTAKE:
${intakeSummary}

MASTER RESUME TEXT (facts only — do not add employers, dates, or skills not listed here):
${masterExcerpt || '(empty — stay conservative)'}

JOB:
Title: ${job.title}
Company: ${job.company}
Fit score: ${job.fit_score}
Fit rationale: ${job.fit_rationale || ''}

Cover letter policy: ${profile.intake?.cover_letter_policy || 'full letter when required'}

Respond JSON only:
{
  "candidate_name": "${name}",
  "why_me_summary": "2-3 sentences for CEO review",
  "tailoring_notes": "brief note that master resume is reused; what the cover letter emphasizes",
  "cover_letter_text": "full cover letter body (no Regards line)"
}`;

  try {
    const { content } = await chatCompletions({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1200,
    });
    const jsonMatch = (content || '').match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content || '{}');
    if (parsed.why_me_summary && parsed.cover_letter_text) {
      parsed.candidate_name = parsed.candidate_name || name;
      if (Array.isArray(parsed.tailoring_notes)) {
        parsed.tailoring_notes = parsed.tailoring_notes.map((v) => String(v)).join('\n');
      }
      if (Array.isArray(parsed.cover_letter_text)) {
        parsed.cover_letter_text = parsed.cover_letter_text.map((v) => String(v)).join('\n');
      }
      return parsed;
    }
  } catch (_) {}

  return fallbackTailoring(job, profile);
}

export async function readMasterResumeText(profile) {
  const masterPath = resolveMasterResumePath(profile.intake?.master_resume_path);
  if (!masterPath || !existsSync(masterPath)) {
    throw new Error(`Master resume not found: ${profile.intake?.master_resume_path}`);
  }
  const text = await extractPdfText(masterPath);
  return { masterPath, masterText: text };
}

export async function tailorResumeForJob({
  ceoUserId,
  profileId,
  jobId,
  syncSpreadsheet = true,
  createKanban = false,
} = {}) {
  const dbFn = () => getDbForCeo(ceoUserId);
  const profileSvc = createJobSearchProfileService(dbFn);
  const jobsSvc = createJobApplicationsService(dbFn);
  const sheetSvc = createJobApplicantSpreadsheetService(dbFn);

  const gate = profileSvc.assertActive(ceoUserId, profileId);
  if (!gate.active) throw new Error(gate.error);

  const profile = gate.profile;
  const job = jobsSvc.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const { masterPath, masterText } = await readMasterResumeText(profile);
  if (!masterText || masterText.length < 80) {
    throw new Error(
      'Master resume PDF has little extractable text. Use a text-based PDF (not scanned image-only).'
    );
  }

  const variantDir = join(materialsRoot(), ceoUserId || 'default', profile.id);
  if (!existsSync(variantDir)) mkdirSync(variantDir, { recursive: true });

  const coverLetterPdfPath = join(variantDir, `${jobId}-cover-letter.pdf`);
  const notesPath = join(variantDir, `${jobId}-tailoring-notes.md`);

  const content = await generateTailoringContent(job, profile, masterText);
  const candidateName = content.candidate_name || profile.display_name || 'Candidate';

  const coverPolicy = String(profile.intake?.cover_letter_policy || 'full letter').toLowerCase();
  const includeCoverLetter =
    coverPolicy !== 'why_me_only' && coverPolicy !== 'none' && coverPolicy !== 'skip';

  let coverLetterPdf = null;
  if (includeCoverLetter && content.cover_letter_text) {
    await writeCoverLetterPdf({
      outputPath: coverLetterPdfPath,
      bodyText: content.cover_letter_text,
      job,
      candidateName,
    });
    coverLetterPdf = coverLetterPdfPath;
  }

  writeFileSync(
    notesPath,
    [
      `# Cover letter — ${job.title} @ ${job.company}`,
      '',
      `Master resume (reused): ${masterPath}`,
      '',
      '## Why me (CEO review)',
      content.why_me_summary || '',
      '',
      '## Notes',
      content.tailoring_notes || 'Master resume reused; cover letter tailored for this job.',
      '',
      '## Cover letter',
      content.cover_letter_text || '(none)',
    ].join('\n'),
    'utf8'
  );

  const materialLinks = buildJobMaterialLinks(ceoUserId, profile.id, jobId);

  const updated = jobsSvc.update(jobId, {
    status: 'awaiting_approval',
    why_me_summary: content.why_me_summary,
    tailoring_notes: content.tailoring_notes,
    cover_letter_text: content.cover_letter_text,
    owner_action: 'review',
    extra: {
      resume_variant_path: masterPath,
      uses_master_resume: true,
      cover_letter_path: coverLetterPdf,
      master_resume_path: masterPath,
      tailoring_notes_path: notesPath,
      resume_pdf_url: materialLinks.resume_pdf,
      cover_letter_pdf_url: materialLinks.cover_letter_pdf,
      materials_ready: !!coverLetterPdf || coverPolicy === 'why_me_only',
    },
  });

  updated.resume_variant_path = masterPath;
  updated.cover_letter_path = coverLetterPdf;
  updated.uses_master_resume = true;

  let spreadsheet = null;
  if (syncSpreadsheet) {
    spreadsheet = sheetSvc.syncProfile(ceoUserId, profile.id, profile.intake);
  }

  return {
    ok: true,
    job_id: jobId,
    profile_id: profile.id,
    ceo_user_id: ceoUserId,
    master_resume_path: masterPath,
    master_resume_chars: masterText.length,
    resume_variant_path: masterPath,
    uses_master_resume: true,
    cover_letter_path: coverLetterPdf,
    tailoring_notes_path: notesPath,
    material_links: materialLinks,
    ceo_review_required: true,
    next_step: 'CEO reviews master resume + cover letter PDFs in Kanban, then Application Agent submits after job_ceo_review_confirm',
    job: updated,
    spreadsheet,
    kanban: createKanban ? { consolidated: true } : null,
  };
}
