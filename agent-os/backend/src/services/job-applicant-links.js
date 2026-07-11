/**
 * Build API links for Kanban / CEO review (relative paths — work through Vite proxy + auth).
 */
import { getPublicBaseUrl as resolvePublicBaseUrl } from '../config/public-url.js';
const PLACEHOLDER_RE = /test|example|placeholder|dummy|BalajiJobApps|1Test/i;

export function isConfiguredGoogleSheetId(id) {
  const s = (id || '').trim();
  if (!s) return false;
  if (s.startsWith('http')) return !PLACEHOLDER_RE.test(s);
  if (PLACEHOLDER_RE.test(s)) return false;
  return s.length >= 20 && /^[a-zA-Z0-9_-]+$/.test(s);
}

export function isConfiguredGDriveFolderId(id) {
  const s = (id || '').trim();
  if (!s) return false;
  if (s.startsWith('http')) return !PLACEHOLDER_RE.test(s);
  if (PLACEHOLDER_RE.test(s)) return false;
  return s.length >= 15 && /^[a-zA-Z0-9_-]+$/.test(s);
}

export function buildGoogleSheetLink(sheetId) {
  if (!isConfiguredGoogleSheetId(sheetId)) return null;
  const s = sheetId.trim();
  if (s.startsWith('http')) return s;
  return `https://docs.google.com/spreadsheets/d/${s}/edit`;
}

export function buildGDriveFolderLink(folderId) {
  if (!isConfiguredGDriveFolderId(folderId)) return null;
  const s = folderId.trim();
  if (s.startsWith('http')) return s;
  return `https://drive.google.com/drive/folders/${s}`;
}

/** @deprecated Use relative API paths; kept for external callbacks if needed. */
export function getPublicBaseUrl() {
  return resolvePublicBaseUrl();
}

function profileQuery(ceoUserId, profileId) {
  return new URLSearchParams({
    ceo_user_id: ceoUserId || 'default',
    profile_id: profileId || 'default',
  });
}

/** Relative authenticated API paths (frontend proxy + Bearer token). */
export function buildTrackerApiLinks(ceoUserId, profileId) {
  const q = profileQuery(ceoUserId, profileId);
  return {
    csv_download: `/api/job-applicant/spreadsheet/download?${q}`,
    summary_view: `/api/job-applicant/spreadsheet/summary?${q}`,
    json_meta: `/api/job-applicant/spreadsheet?${q}`,
  };
}

export function buildMasterResumeLink(ceoUserId, profileId) {
  const q = profileQuery(ceoUserId, profileId);
  return `/api/job-applicant/master-resume/download?${q}`;
}

/** Resume = master PDF; cover letter = per-job tailored PDF. */
export function buildJobMaterialLinks(ceoUserId, profileId, jobId) {
  const q = profileQuery(ceoUserId, profileId);
  const prefix = `/api/job-applicant/jobs/${encodeURIComponent(jobId)}/materials`;
  return {
    resume_pdf: buildMasterResumeLink(ceoUserId, profileId),
    cover_letter_pdf: `${prefix}/cover-letter.pdf?${q}`,
  };
}

export function buildResumeStorageLabel(profile, variantPath, job = null) {
  const intake = profile?.intake || profile || {};
  const root = (intake.gdrive_root_folder || '').trim();
  const driveLink = buildGDriveFolderLink(root);
  if (driveLink && variantPath) {
    const fileName = variantPath.split(/[/\\]/).pop();
    return `GDrive: ${driveLink} — upload \`${fileName}\` when Drive sync is configured`;
  }
  if (driveLink) return `GDrive folder: ${driveLink}`;
  if (job?.uses_master_resume || job?.resume_pdf_url?.includes('master-resume')) {
    return `[Master resume PDF](${job.resume_pdf_url || buildMasterResumeLink(profile?.ceo_user_id, profile?.id)})`;
  }
  if (variantPath && job?.resume_pdf_url) {
    return `[Resume PDF](${job.resume_pdf_url})`;
  }
  if (variantPath) return `Master resume: ${variantPath.split(/[/\\]/).pop()}`;
  return intake.master_resume_path ? `Master resume: ${intake.master_resume_path}` : '(resume not set)';
}

export function isExternalJobPortalUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  try {
    const u = new URL(url);
    if (['127.0.0.1', 'localhost'].includes(u.hostname.toLowerCase())) return false;
    if (u.pathname.startsWith('/api/')) return false;
    return true;
  } catch (_) {
    return false;
  }
}
