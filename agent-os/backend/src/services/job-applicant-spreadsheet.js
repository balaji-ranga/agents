/**
 * Job applicant tracker spreadsheet — local CSV sync (Phase 1).
 * Google Sheets integration can replace this when credentials are configured.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createJobApplicationsService } from './job-applications.js';
import { buildGoogleSheetLink, buildTrackerApiLinks } from './job-applicant-links.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COLUMNS = [
  'job_id',
  'profile_id',
  'profile_display_name',
  'profile_target_titles',
  'profile_workflow_schedule',
  'ceo_user_id',
  'status',
  'company',
  'title',
  'location',
  'url',
  'fit_score',
  'fit_rationale',
  'why_me_summary',
  'resume_variant_path',
  'linkedin_profile',
  'cover_letter_text',
  'tailoring_notes',
  'owner_action',
  'updated_at',
];

function dataRoot() {
  const base = process.env.AGENT_OS_DATA_DIR || join(__dirname, '../../data');
  return join(base, 'job-applicant', 'spreadsheets');
}

function escapeCsv(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsvLine(job) {
  return COLUMNS.map((col) => escapeCsv(job[col])).join(',');
}

export function getSpreadsheetPaths(ceoUserId, profileId) {
  const dir = join(dataRoot(), ceoUserId || 'default', profileId || 'default');
  return {
    dir,
    csv_path: join(dir, 'tracker.csv'),
    summary_path: join(dir, 'matches-summary.md'),
    public_label: `job-applicant/spreadsheets/${ceoUserId || 'default'}/${profileId || 'default'}/tracker.csv`,
  };
}

function buildSummaryMarkdown(jobs, { ceoUserId, profileId, profileIntake = {}, profileMeta = {} } = {}) {
  const titles = Array.isArray(profileIntake.target_titles) ? profileIntake.target_titles.join(', ') : '';
  const displayName = profileMeta.display_name || profileId;
  const schedule = profileIntake.workflow_schedule || profileIntake.discovery_schedule || 'daily';
  const links = buildTrackerApiLinks(ceoUserId, profileId);
  const sheetLink = buildGoogleSheetLink(profileIntake.google_sheet_id);
  const lines = [
    '# Job Matches Summary',
    '',
    '## Job search profile (this spreadsheet belongs to)',
    `- **profile_id:** \`${profileId}\``,
    `- **display_name:** ${displayName}`,
    `- **ceo_user_id:** ${ceoUserId}`,
    `- **target_titles:** ${titles || '(not set)'}`,
    `- **workflow_schedule:** ${schedule}`,
    `- **fit_threshold:** ${profileIntake.fit_threshold ?? '—'}%`,
    `- **sources:** ${Array.isArray(profileIntake.sources) ? profileIntake.sources.join(', ') : profileIntake.sources || '—'}`,
    `- **linkedin_profile:** ${profileIntake.linkedin_profile || '(not set)'}`,
    `- **Generated:** ${new Date().toISOString()}`,
    '',
    '## Tracker links',
    `- [Download CSV](${links.csv_download})`,
    `- [View this summary](${links.summary_view})`,
    sheetLink ? `- [Google Sheet (live)](${sheetLink})` : '- _Google Sheet: not configured (using local CSV)_',
    '',
    '## Shortlisted / awaiting review',
    '',
  ];
  const reviewJobs = jobs.filter((j) =>
    ['shortlisted', 'borderline', 'resume_ready', 'awaiting_approval', 'approved'].includes(j.status)
  );
  if (reviewJobs.length === 0) {
    lines.push('_No jobs in review queue yet._');
  } else {
    for (const j of reviewJobs) {
      lines.push(`### ${j.title || 'Untitled'} — ${j.company || 'Unknown'}`);
      lines.push(`- **job_id:** \`${j.job_id}\``);
      lines.push(`- **status:** ${j.status}`);
      lines.push(`- **fit_score:** ${j.fit_score ?? '—'}%`);
      if (j.url) lines.push(`- **Job portal:** [${j.url}](${j.url})`);
      if (j.source) lines.push(`- **source:** ${j.source}`);
      if (j.fit_rationale) lines.push(`- **fit:** ${j.fit_rationale}`);
      const resume = j.resume_drive_link || j.resume_variant_path;
      if (resume) lines.push(`- **resume:** ${resume}`);
      if (j.why_me_summary) lines.push(`- **why me:** ${j.why_me_summary}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function createJobApplicantSpreadsheetService(getDb) {
  const jobsService = () => createJobApplicationsService(getDb);

  return {
    syncProfile(ceoUserId, profileId, profileIntake = {}, profileMeta = {}) {
      if (!profileId) throw new Error('profile_id required');
      const paths = getSpreadsheetPaths(ceoUserId, profileId);
      if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });

      const titles = Array.isArray(profileIntake.target_titles) ? profileIntake.target_titles.join('; ') : '';
      const displayName = profileMeta.display_name || profileId;
      const schedule = profileIntake.workflow_schedule || profileIntake.discovery_schedule || 'daily';
      const linkedin = profileIntake.linkedin_profile || '';

      const jobs = jobsService().list({
        ceo_user_id: ceoUserId,
        profile_id: profileId,
        limit: 500,
      });

      const header = COLUMNS.join(',');
      const rows = jobs.map((j) => {
        const extra = {};
        if (j.resume_variant_path) extra.resume_variant_path = j.resume_variant_path;
        return rowToCsvLine({
          job_id: j.job_id,
          profile_id: j.profile_id || profileId,
          profile_display_name: displayName,
          profile_target_titles: titles,
          profile_workflow_schedule: schedule,
          ceo_user_id: j.ceo_user_id || ceoUserId,
          status: j.status,
          company: j.company,
          title: j.title,
          location: j.location,
          url: j.url,
          fit_score: j.fit_score,
          fit_rationale: j.fit_rationale,
          why_me_summary: j.why_me_summary,
          resume_variant_path: j.resume_variant_path || extra.resume_variant_path || '',
          linkedin_profile: linkedin,
          cover_letter_text: j.cover_letter_text,
          tailoring_notes: j.tailoring_notes,
          owner_action: j.owner_action,
          updated_at: j.updated_at,
        });
      });

      writeFileSync(paths.csv_path, [header, ...rows].join('\n') + '\n', 'utf8');
      const apiLinks = buildTrackerApiLinks(ceoUserId, profileId);
      writeFileSync(
        paths.summary_path,
        buildSummaryMarkdown(jobs, { ceoUserId, profileId, profileIntake, profileMeta }),
        'utf8'
      );
      writeFileSync(
        join(paths.dir, 'profile-meta.json'),
        JSON.stringify(
          {
            profile_id: profileId,
            profile_display_name: displayName,
            ceo_user_id: ceoUserId,
            target_titles: profileIntake.target_titles || [],
            workflow_schedule: schedule,
            fit_threshold: profileIntake.fit_threshold,
            sources: profileIntake.sources,
            linkedin_profile: linkedin,
            master_resume_path: profileIntake.master_resume_path,
            google_sheet_configured: !!buildGoogleSheetLink(profileIntake.google_sheet_id),
            updated_at: new Date().toISOString(),
            tracker_links: apiLinks,
          },
          null,
          2
        ),
        'utf8'
      );

      return {
        ok: true,
        ceo_user_id: ceoUserId,
        profile_id: profileId,
        profile_display_name: displayName,
        csv_path: paths.csv_path,
        summary_path: paths.summary_path,
        tracker_links: apiLinks,
        job_count: jobs.length,
        columns: COLUMNS,
      };
    },

    readTracker(ceoUserId, profileId) {
      const paths = getSpreadsheetPaths(ceoUserId, profileId);
      if (!existsSync(paths.csv_path)) {
        return { exists: false, csv_path: paths.csv_path, rows: [] };
      }
      const text = readFileSync(paths.csv_path, 'utf8');
      const lines = text.trim().split(/\r?\n/);
      if (lines.length <= 1) return { exists: true, csv_path: paths.csv_path, rows: [] };
      const header = parseCsvLine(lines[0]);
      const rows = lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const obj = {};
        header.forEach((h, i) => {
          obj[h.trim()] = (values[i] ?? '').trim();
        });
        return obj;
      });
      return { exists: true, csv_path: paths.csv_path, summary_path: paths.summary_path, rows };
    },

    getJobRow(ceoUserId, profileId, jobId) {
      const tracker = this.readTracker(ceoUserId, profileId);
      return tracker.rows.find((r) => r.job_id === jobId) || null;
    },
  };
}
