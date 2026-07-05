/**
 * Candidate context for fit scoring — intake + optional summary file.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUMMARY_MAX = 4000;

/** Resolve master resume path (absolute or relative to repo root). */
export function resolveMasterResumePath(masterPath) {
  if (!masterPath) return null;
  const p = String(masterPath).trim();
  if (existsSync(p)) return p;
  const fromRepo = join(__dirname, '../../../..', p.replace(/^[/\\]/, ''));
  if (existsSync(fromRepo)) return fromRepo;
  return p;
}

export function readTextFileIfExists(filePath, maxChars = SUMMARY_MAX) {
  if (!filePath || !existsSync(filePath)) return '';
  try {
    return readFileSync(filePath, 'utf8').slice(0, maxChars).trim();
  } catch {
    return '';
  }
}

/** Resolve candidate summary: explicit intake → profile_summary_path → sibling of resume → default me/summary.txt */
export function resolveCandidateSummary(intake = {}) {
  if (intake.candidate_summary?.trim()) {
    return intake.candidate_summary.trim().slice(0, SUMMARY_MAX);
  }
  const paths = [];
  if (intake.profile_summary_path?.trim()) paths.push(intake.profile_summary_path.trim());
  if (intake.master_resume_path?.trim()) {
    paths.push(join(dirname(intake.master_resume_path), 'summary.txt'));
  }
  paths.push(join(process.cwd(), '..', '1_foundations', 'me', 'summary.txt'));
  for (const p of paths) {
    const text = readTextFileIfExists(p);
    if (text) return text;
  }
  return '';
}

export function parseBorderlineReview(intake = {}) {
  const threshold = Number(intake.fit_threshold) || 70;
  const br = intake.borderline_review;
  if (br === false || br === 'no' || br === 'disabled') {
    return { enabled: false, min_score: threshold, threshold };
  }
  if (typeof br === 'object' && br !== null) {
    const min = Number(br.min_score);
    return {
      enabled: br.enabled !== false,
      min_score: Number.isFinite(min) ? min : Math.max(50, threshold - 15),
      threshold,
    };
  }
  // Default: show jobs between (threshold - 15) and threshold for CEO selective include
  return { enabled: true, min_score: Math.max(50, threshold - 15), threshold };
}

export function parseDiscoveryDepth(intake = {}) {
  const d = intake.discovery_depth && typeof intake.discovery_depth === 'object' ? intake.discovery_depth : {};
  return {
    min_jobs_per_source: Number(d.min_jobs_per_source) || Number(intake.discovery_min_per_source) || 10,
    max_jobs_per_run: Number(d.max_jobs_per_run) || Number(intake.discovery_max_per_run) || 25,
    linkedin_pages: Number(d.linkedin_pages) || 3,
    jobstreet_pages: Number(d.jobstreet_pages) || 3,
    use_multiple_queries: d.use_multiple_queries !== false,
  };
}

export function buildCandidateContextForScoring(profile) {
  const intake = profile?.intake || {};
  const candidateSummary = resolveCandidateSummary(intake);
  return {
    intake,
    intakeJson: JSON.stringify(intake, null, 2).slice(0, 8000),
    candidateSummary,
    linkedinProfile: intake.linkedin_profile || '',
    borderline: parseBorderlineReview(intake),
    discoveryDepth: parseDiscoveryDepth(intake),
  };
}
