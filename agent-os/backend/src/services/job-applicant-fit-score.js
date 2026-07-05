/**
 * LLM fit scoring for job applicant workflow (shared by tools + workflow runner).
 */
import { chatCompletions } from '../config/llm.js';
import { createJobApplicationsService } from './job-applications.js';
import { enrichJobFromUrl } from './job-job-enrichment.js';
import { buildCandidateContextForScoring, parseBorderlineReview } from './job-candidate-context.js';

async function fetchUrlSummary(url) {
  if (!url) return '';
  try {
    const base = (process.env.AGENT_OS_PUBLIC_URL || `http://127.0.0.1:${Number(process.env.PORT) || 3001}`).replace(/\/$/, '');
    const r = await fetch(`${base}/api/tools/summarize-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-test': '1', 'x-openclaw-agent-id': 'fitscorer' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json().catch(() => ({}));
    return data.summary || '';
  } catch (_) {
    return '';
  }
}

function buildJobDescriptionText(job, jobDescription = '') {
  let descriptionText = (jobDescription || job.job_description || '').trim();
  if (!descriptionText && job.extra?.job_description) {
    descriptionText = String(job.extra.job_description).trim();
  }
  if (!descriptionText && job.url) {
    descriptionText = '';
  }
  return descriptionText;
}

function resolveStatusFromScore({ fitScore, threshold, borderline, llmRecommended }) {
  if (llmRecommended === 'shortlisted' && fitScore >= borderline.min_score) return 'shortlisted';
  if (llmRecommended === 'skipped') {
    if (borderline.enabled && fitScore >= borderline.min_score && fitScore < threshold) return 'borderline';
    return 'skipped';
  }
  if (fitScore >= threshold) return 'shortlisted';
  if (borderline.enabled && fitScore >= borderline.min_score && fitScore < threshold) return 'borderline';
  return 'skipped';
}

export async function scoreJobForProfile({ profile, job, jobDescription = '', jobsSvc = null, updateRow = true } = {}) {
  if (!profile?.id) throw new Error('profile required');
  const enriched = enrichJobFromUrl(job || {});
  if (!enriched?.job_id && !enriched?.title && !enriched?.url) throw new Error('job required');

  const ctx = buildCandidateContextForScoring(profile);
  const borderline = ctx.borderline;
  const threshold = borderline.threshold;

  let descriptionText = buildJobDescriptionText(enriched, jobDescription);
  if (!descriptionText && enriched.url) {
    descriptionText = await fetchUrlSummary(enriched.url);
  }
  const slugHint = enriched.title && enriched.company
    ? `${enriched.title} at ${enriched.company}`
    : enriched.title || enriched.company || '';

  const prompt = `You are a job fit scorer. Compare this job to the candidate profile and summary. Score 0-100. Be honest; cite matching and missing criteria. Never invent candidate qualifications.

CANDIDATE PROFILE (JSON):
${ctx.intakeJson}

CANDIDATE SUMMARY (from resume / profile notes):
${ctx.candidateSummary || '(not provided — use profile JSON only)'}

CANDIDATE LINKEDIN: ${ctx.linkedinProfile || '(not set)'}

FIT RULES:
- fit_threshold: ${threshold}% → shortlisted if score >= ${threshold}
- borderline band: ${borderline.enabled ? `${borderline.min_score}%–${threshold - 1}% → borderline (CEO may include)` : 'disabled'}

JOB:
Title: ${enriched.title || slugHint || ''}
Company: ${enriched.company || ''}
Location: ${enriched.location || ''}
URL: ${enriched.url || ''}
Source: ${enriched.source || ''}
Description:
${(descriptionText || slugHint || '(no description — infer cautiously from URL/title)').slice(0, 6000)}

Respond with JSON only:
{"fit_score": number, "fit_rationale": "2-4 sentences", "must_haves_met": true/false, "recommended_status": "shortlisted" or "borderline" or "skipped"}`;

  const { content } = await chatCompletions({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 500,
  });

  let parsed = {};
  try {
    const jsonMatch = (content || '').match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content || '{}');
  } catch (_) {
    parsed = { fit_score: 0, fit_rationale: content || 'Could not parse score', recommended_status: 'skipped' };
  }

  const fitScore = Math.max(0, Math.min(100, Number(parsed.fit_score) || 0));
  let llmStatus = parsed.recommended_status;
  if (!['shortlisted', 'borderline', 'skipped'].includes(llmStatus)) llmStatus = null;

  const status = resolveStatusFromScore({
    fitScore,
    threshold,
    borderline,
    llmRecommended: llmStatus,
  });

  const result = {
    job_id: enriched.job_id,
    fit_score: fitScore,
    fit_rationale: parsed.fit_rationale || '',
    must_haves_met: parsed.must_haves_met,
    recommended_status: status,
    status,
    threshold,
    borderline_min: borderline.min_score,
    profile_id: profile.id,
    title: enriched.title,
    company: enriched.company,
  };

  if (updateRow && enriched.job_id && jobsSvc) {
    const patch = {
      fit_score: fitScore,
      fit_rationale: result.fit_rationale,
      status,
      extra: {
        must_haves_met: parsed.must_haves_met,
        borderline_eligible: status === 'borderline',
        scored_at: new Date().toISOString(),
      },
    };
    if (enriched.title && !job.title) patch.title = enriched.title;
    if (enriched.company && !job.company) patch.company = enriched.company;
    if (enriched.source && !job.source) patch.source = enriched.source;
    if (descriptionText) patch.extra.job_description = descriptionText.slice(0, 8000);
    jobsSvc.update(enriched.job_id, patch);
    result.job = jobsSvc.get(enriched.job_id);
  }

  return result;
}

export async function scoreDiscoveredJobsForProfile(ceoUserId, profileId, profile, jobsSvc) {
  const discovered = jobsSvc.list({
    status: 'discovered',
    ceo_user_id: ceoUserId,
    profile_id: profileId,
    limit: 100,
  });

  const results = [];
  for (const job of discovered) {
    results.push(
      await scoreJobForProfile({
        profile,
        job,
        jobsSvc,
        updateRow: true,
      })
    );
  }

  return {
    scored: results.length,
    shortlisted: results.filter((r) => r.status === 'shortlisted').length,
    borderline: results.filter((r) => r.status === 'borderline').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  };
}

export { parseBorderlineReview, buildCandidateContextForScoring };
