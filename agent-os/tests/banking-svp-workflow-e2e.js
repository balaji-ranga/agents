/**
 * Banking SVP full workflow E2E: discovery → fit score → resume PDF + cover letter → Kanban CEO review.
 * Run: node tests/banking-svp-workflow-e2e.js
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../backend/src/db/schema.js';
import { createJobSearchProfileService } from '../backend/src/services/job-search-profile.js';
import { createJobApplicationsService, makeJobId } from '../backend/src/services/job-applications.js';
import { runJobSearchWorkflowNow } from '../backend/src/services/job-applicant-workflow-run.js';
import { resolveKanbanTaskArtifacts } from '../backend/src/services/kanban-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const RESUME = join(AGENT_OS_ROOT, '..', '1_foundations', 'me', 'Bala_resume_latest.pdf');

function loadEnv() {
  const envPath = join(AGENT_OS_ROOT, 'backend', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}

loadEnv();
if (!process.env.OPENAI_PRIMARY_API_KEY && !process.env.OPENAI_API_KEY) {
  process.env.OPENAI_PRIMARY_BASE_URL =
    process.env.OPENAI_PRIMARY_BASE_URL || 'http://127.0.0.1:11434/v1';
  process.env.OPENAI_PRIMARY_MODEL = process.env.OPENAI_PRIMARY_MODEL || 'llama3.2:latest';
}

const CEO = 'default';
const PROFILE = 'banking-svp-cloud-sg';

initDb();
const db = getDb();
const profileSvc = createJobSearchProfileService(() => db);
const jobsSvc = createJobApplicationsService(() => db);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓', msg);
  } else {
    failed++;
    console.error('  ✗', msg);
  }
}

console.log('\n=== Banking SVP workflow E2E ===\n');
console.log(
  `LLM: ${process.env.OPENAI_PRIMARY_BASE_URL || process.env.OPENAI_BASE_URL || 'default'} / ${process.env.OPENAI_PRIMARY_MODEL || process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o-mini'}\n`
);

// Setup: active profile + cover letter policy + master resume path
db.prepare(
  `INSERT INTO job_search_ceo_settings (ceo_user_id, active_profile_id, updated_at)
   VALUES (?, ?, datetime('now'))
   ON CONFLICT(ceo_user_id) DO UPDATE SET active_profile_id = excluded.active_profile_id`
).run(CEO, PROFILE);

const profile = profileSvc.getProfile(CEO, PROFILE);
assert(profile?.status === 'active', `Profile ${PROFILE} is active`);
assert(existsSync(RESUME), `Master resume PDF exists (${RESUME})`);

const intake = {
  ...profile.intake,
  cover_letter_policy: 'full letter',
  master_resume_path: RESUME,
};
profileSvc.savePatch(CEO, PROFILE, intake);
profileSvc.confirm(CEO, PROFILE, true);
profileSvc.setActiveProfile(CEO, PROFILE);
assert(profileSvc.getProfile(CEO, PROFILE)?.status === 'active', 'Profile re-confirmed after intake patch');

// Reset prior test jobs for clean discovery → score path
const testUrl = `https://example.com/banking-svp-e2e-${Date.now()}`;
const jobId = makeJobId(testUrl, 'DBS Bank', 'SVP Head of Cloud Platform', PROFILE);

const appended = jobsSvc.append(
  [
    {
      job_id: jobId,
      url: testUrl,
      company: 'DBS Bank',
      title: 'SVP Head of Cloud Platform',
      location: 'Singapore',
      source: 'linkedin',
      job_description:
        'Senior technology leader for cloud platform, banking transformation, AWS/Azure, executive stakeholder management.',
    },
  ],
  { ceo_user_id: CEO, profile_id: PROFILE, skip_if_seen: false }
);
assert(appended.count_added === 1, 'Discovered job appended');

console.log('\n--- Workflow: score + tailor + CEO Kanban ---');
const wf = await runJobSearchWorkflowNow(CEO, PROFILE, {
  scoreDiscovered: true,
  submitReview: true,
  tailorShortlisted: true,
  trigger: 'banking_svp_e2e',
});

assert(wf.ok, 'Workflow completed');
assert(wf.scoring?.scored >= 1, `Workflow scored ${wf.scoring?.scored ?? 0} job(s)`);
assert(wf.kanban_task_id, `Kanban CEO review task #${wf.kanban_task_id}`);
assert(wf.kanban_status === 'awaiting_confirmation', `Kanban status: ${wf.kanban_status}`);
assert(wf.awaiting_approval_count >= 1, `${wf.awaiting_approval_count} job(s) awaiting approval`);

const jobAfter = jobsSvc.get(jobId);
assert(jobAfter.status === 'awaiting_approval', `Job status: ${jobAfter.status}`);
assert(jobAfter.uses_master_resume === true, 'Reuses master resume (no tailored resume PDF)');
assert(
  jobAfter.resume_variant_path && existsSync(jobAfter.resume_variant_path),
  `Master resume path: ${jobAfter.resume_variant_path?.split(/[/\\]/).pop()}`
);
assert(
  jobAfter.cover_letter_path && jobAfter.cover_letter_path.endsWith('.pdf'),
  `Cover letter PDF: ${jobAfter.cover_letter_path?.split(/[/\\]/).pop()}`
);
assert(existsSync(jobAfter.cover_letter_path), 'Cover letter PDF file exists on disk');
const tailoredResumePath = join(
  AGENT_OS_ROOT,
  'backend/data/job-applicant/resumes/default/banking-svp-cloud-sg',
  `${jobId}-resume.pdf`
);
assert(!existsSync(tailoredResumePath), 'No per-job tailored resume PDF generated');

const kanban = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(wf.kanban_task_id);
assert(kanban?.status === 'awaiting_confirmation', 'Kanban task in DB');

const ceoStep = wf.workflow?.steps?.find((s) => s.step_key === 'ceo_confirm');
assert(ceoStep?.status === 'in_progress', 'Workflow at CEO confirm step');

console.log('\n--- Kanban stage tasks (fit scoring, resume tailoring) ---');
const stageTasks = db
  .prepare(
    `SELECT id, title, status, assigned_agent_id, description FROM kanban_tasks
     WHERE description LIKE ? AND description LIKE '%[job_pipeline:%'
     ORDER BY id ASC`
  )
  .all(`%workflow_id: ${wf.workflow_id}%`);

const fitTask = stageTasks.find((t) => t.description.includes('[job_pipeline:fitscorer]'));
const tailorTask = stageTasks.find((t) => t.description.includes('[job_pipeline:resumetailor]'));

assert(fitTask?.status === 'completed', `Fit Scoring Kanban #${fitTask?.id} completed (agent: ${fitTask?.assigned_agent_id})`);
assert(tailorTask?.status === 'completed', `Resume Tailoring Kanban #${tailorTask?.id} completed (agent: ${tailorTask?.assigned_agent_id})`);
assert(fitTask?.assigned_agent_id === 'fitscorer', 'Fit task assigned to fitscorer');
assert(tailorTask?.assigned_agent_id === 'resumetailor', 'Tailor task assigned to resumetailor');

const fitArtifacts = resolveKanbanTaskArtifacts(fitTask);
const tailorArtifacts = resolveKanbanTaskArtifacts(tailorTask);
const ceoArtifacts = resolveKanbanTaskArtifacts(kanban);

assert(fitArtifacts.count >= 1, `Fit scoring task has ${fitArtifacts.count} artifact(s)`);
assert(
  tailorArtifacts.artifacts.some((a) => a.kind === 'pdf' && a.label.includes('Cover letter')),
  `Resume tailoring task has cover letter PDFs (${tailorArtifacts.artifacts.filter((a) => a.label.includes('Cover letter')).length})`
);
assert(
  tailorArtifacts.artifacts.some((a) => a.kind === 'csv' && a.url?.startsWith('/api/')),
  'Resume tailoring task includes authenticated tracker CSV artifact'
);
assert(
  ceoArtifacts.artifacts.some((a) => a.kind === 'pdf' && a.label.includes('Cover letter')),
  `CEO review task has cover letter PDFs (${ceoArtifacts.artifacts.filter((a) => a.label.includes('Cover letter')).length})`
);
assert(
  !ceoArtifacts.artifacts.some((a) => a.url?.includes('127.0.0.1')),
  'CEO review artifacts have no localhost links'
);

console.log(`  Fit scoring task #${fitTask.id}: ${fitArtifacts.count} artifacts`);
console.log(`  Resume tailoring task #${tailorTask.id}: ${tailorArtifacts.artifacts.filter((a) => a.kind === 'pdf').length} PDFs, ${tailorArtifacts.count} total`);
console.log(`  CEO review task #${kanban.id}: ${ceoArtifacts.count} artifacts`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
console.log(`Kanban: http://127.0.0.1:3000/kanban`);
console.log(`  Fit Scoring #${fitTask?.id} · Resume Tailoring #${tailorTask?.id} · CEO Review #${wf.kanban_task_id}`);
console.log(`Workflow #${wf.workflow_number} awaiting CEO confirm\n`);

if (failed > 0) process.exit(1);
