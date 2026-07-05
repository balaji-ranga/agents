/**
 * Set up Job Applicant workflow agents and tools without modifying existing agent templates.
 *
 * - Creates jobdiscovery, fitscorer, resumetailor, applicationagent (if missing)
 * - Applies workspace templates from openclaw-workspace-templates/
 * - Seeds job-applicant tools and per-agent tool overrides
 * - Merges new agents into ~/.openclaw/openclaw.json (does not touch apply-openclaw-agents-config.js)
 * - Appends delegation rows to BalServe AGENTS.md via createFullAgent (new agents only)
 *
 * Usage (from agent-os):
 *   node scripts/setup-job-applicant-agents.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATES = join(ROOT, 'openclaw-workspace-templates');
const homedir = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(homedir, '.openclaw');
const CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');
const OVERRIDES_PATH = join(OPENCLAW_DIR, 'agent-os-tool-overrides.json');

const toSlash = (p) => p.replace(/\\/g, '/');

const JOB_AGENTS = [
  {
    id: 'jobdiscovery',
    name: 'Job Discovery',
    role: 'Job search profile intake and job discovery; reports to COO',
  },
  {
    id: 'fitscorer',
    name: 'Fit Scoring',
    role: 'Score discovered jobs vs CEO profile; reports to COO',
  },
  {
    id: 'resumetailor',
    name: 'Resume Tailoring',
    role: 'Honest resume variants and cover letters; reports to COO',
  },
  {
    id: 'applicationagent',
    name: 'Application Agent',
    role: 'Fill job applications after CEO approval; reports to COO',
  },
];

const { initDb, getDb } = await import(new URL('../backend/src/db/schema.js', import.meta.url).href);
const { createFullAgent } = await import(new URL('../backend/src/services/create-full-agent.js', import.meta.url).href);
const { seedJobApplicantToolsIfMissing, JOB_AGENT_TOOL_MAP } = await import(
  new URL('../backend/src/db/seed-job-applicant-tools.js', import.meta.url).href
);
const { writeOpenClawToolsList } = await import(
  new URL('../backend/src/services/content-tools-meta.js', import.meta.url).href
);

function applyTemplateFiles(agentId, workspacePath) {
  const templateDir = join(TEMPLATES, agentId);
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true });
  const memoryDir = join(workspacePath, 'memory');
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  for (const file of ['SOUL.md', 'AGENTS.md', 'MEMORY.md', 'TOOLS.md']) {
    const src = join(templateDir, file);
    const dest = join(workspacePath, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      console.log('  applied', file);
    }
  }
}

function mergeToolOverrides() {
  let overrides = {};
  if (existsSync(OVERRIDES_PATH)) {
    try {
      overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    } catch (_) {}
  }
  for (const [agentId, tools] of Object.entries(JOB_AGENT_TOOL_MAP)) {
    for (const toolName of tools) {
      if (!overrides[toolName]) overrides[toolName] = [];
      if (overrides[toolName] === 'All') continue;
      if (!Array.isArray(overrides[toolName])) overrides[toolName] = [];
      if (!overrides[toolName].includes(agentId)) overrides[toolName].push(agentId);
    }
  }
  if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2), 'utf8');
  console.log('Wrote tool overrides:', OVERRIDES_PATH);
  return overrides;
}

function mergeOpenClawConfig(overrides) {
  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error('Could not parse openclaw.json:', e.message);
      process.exit(1);
    }
  }

  if (!config.agents) config.agents = {};
  if (!Array.isArray(config.agents.list)) config.agents.list = [];

  const contentToolNames = [
    'summarize_url',
    'generate_image',
    'generate_video',
    'kanban_move_status',
    'kanban_reassign_to_coo',
    'kanban_assign_task',
    'intent_classify_and_delegate',
    'browser',
    ...Object.keys(JOB_AGENT_TOOL_MAP).length ? [] : [],
  ];

  for (const t of [
    'job_search_profile_list',
    'job_search_profile_create',
    'job_search_profile_set_active',
    'job_search_profile_deactivate',
    'job_search_profile_rename',
    'job_search_profile_delete',
    'job_search_profile_get',
    'job_search_profile_save',
    'job_search_profile_intake_status',
    'job_search_profile_confirm',
    'job_check_profile_active',
    'job_check_url_seen',
    'job_inventory_summary',
    'job_run_workflow_now',
    'job_pipeline_start',
    'job_ceo_review_confirm',
    'jobs_list',
    'jobs_append',
    'jobs_update',
    'job_fit_score',
  ]) {
    if (!contentToolNames.includes(t)) contentToolNames.push(t);
  }

  for (const spec of JOB_AGENTS) {
    const id = spec.id;
    const workspacePath = join(OPENCLAW_DIR, `workspace-${id}`);
    let entry = config.agents.list.find((a) => (a.id || '').toLowerCase() === id);
    const allow = [...(JOB_AGENT_TOOL_MAP[id] || [])];
    if (!entry) {
      entry = {
        id,
        name: spec.name,
        workspace: toSlash(workspacePath),
        tools: { allow, deny: ['image'] },
      };
      config.agents.list.push(entry);
    } else {
      entry.name = spec.name;
      entry.workspace = toSlash(workspacePath);
      entry.tools = entry.tools || {};
      entry.tools.allow = allow;
      entry.tools.deny = entry.tools.deny || ['image'];
    }
  }

  if (!config.tools) config.tools = {};
  if (!config.tools.agentToAgent) config.tools.agentToAgent = { enabled: true, allow: [] };
  if (!Array.isArray(config.tools.agentToAgent.allow)) config.tools.agentToAgent.allow = [];
  for (const spec of JOB_AGENTS) {
    if (!config.tools.agentToAgent.allow.includes(spec.id)) {
      config.tools.agentToAgent.allow.push(spec.id);
    }
  }

  if (!Array.isArray(config.tools.allow)) config.tools.allow = [];
  for (const name of contentToolNames) {
    if (!config.tools.allow.includes(name)) config.tools.allow.push(name);
  }

  for (const a of config.agents.list) {
    const aid = (a.id || '').toLowerCase();
    const jobAllow = JOB_AGENT_TOOL_MAP[aid];
    if (jobAllow) {
      a.tools = a.tools || {};
      a.tools.allow = [...jobAllow];
      a.tools.deny = a.tools.deny || ['image'];
      continue;
    }
    const allow = Array.isArray(a.tools?.allow) ? [...a.tools.allow] : [...contentToolNames];
    for (const [toolName, agentsSpec] of Object.entries(overrides)) {
      if (
        agentsSpec === 'All' ||
        (Array.isArray(agentsSpec) && agentsSpec.some((x) => String(x).toLowerCase() === aid))
      ) {
        if (!allow.includes(toolName)) allow.push(toolName);
      }
    }
    a.tools = a.tools || {};
    a.tools.allow = allow;
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log('Updated', CONFIG_PATH);
}

async function main() {
  initDb();
  seedJobApplicantToolsIfMissing();
  writeOpenClawToolsList();

  const db = getDb();
  const coo = db.prepare('SELECT id FROM agents WHERE is_coo = 1 LIMIT 1').get();
  const parentId = coo?.id || 'balserve';

  for (const spec of JOB_AGENTS) {
    console.log('\n---', spec.id, '---');
    const existing = db.prepare('SELECT id, workspace_path FROM agents WHERE id = ?').get(spec.id);
    let workspacePath = existing?.workspace_path || join(OPENCLAW_DIR, `workspace-${spec.id}`);

    if (!existing) {
      console.log('Creating agent in DB and openclaw.json...');
      const row = await createFullAgent({
        id: spec.id,
        name: spec.name,
        role: spec.role,
        parent_id: parentId,
      });
      workspacePath = row.workspace_path;
      console.log('Created:', row.id);
    } else {
      console.log('Agent exists; refreshing templates and tool allowlist only.');
    }

    applyTemplateFiles(spec.id, workspacePath);
  }

  const overrides = mergeToolOverrides();
  mergeOpenClawConfig(overrides);

  console.log('\nDone. Job Applicant workflow ready.');
  console.log('Next steps:');
  console.log('  1. Restart Agent OS backend (seeds tools on startup).');
  console.log('  2. Restart OpenClaw gateway: npx openclaw gateway --port 18789');
  console.log('  3. Chat with Job Discovery: "Set up my job search profile"');
  console.log('See knowledgebase/JOB-APPLICANT-WORKFLOW.md');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
