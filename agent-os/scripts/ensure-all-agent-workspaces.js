/**
 * Apply SOUL.md and MEMORY.md from openclaw-workspace-templates to each agent's
 * workspace under ~/.openclaw (bala, balserve, techresearcher, expensemanager).
 * SOUL.md is overwritten so memory + guardrails stay in sync; MEMORY.md is
 * created only if missing (to preserve existing agent memory).
 * Run from agent-os: node scripts/ensure-all-agent-workspaces.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATES = join(ROOT, 'openclaw-workspace-templates');
const homedir = process.env.USERPROFILE || process.env.HOME || '';

const AGENTS = [
  { id: 'bala', workspaceDir: 'workspace' },
  { id: 'balserve', workspaceDir: 'workspace-balserve' },
  { id: 'techresearcher', workspaceDir: 'workspace-techresearcher' },
  { id: 'expensemanager', workspaceDir: 'workspace-expenses' },
  { id: 'socialasstant', workspaceDir: 'workspace-socialasstant' },
];

for (const { id, workspaceDir } of AGENTS) {
  const templateDir = join(TEMPLATES, id);
  const workspacePath = join(homedir, '.openclaw', workspaceDir);

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
    console.log('Created', workspacePath);
  }

  const soulPath = join(templateDir, 'SOUL.md');
  const memoryPath = join(templateDir, 'MEMORY.md');
  const toolsPath = join(templateDir, 'TOOLS.md');
  if (existsSync(soulPath)) {
    const soul = readFileSync(soulPath, 'utf8');
    writeFileSync(join(workspacePath, 'SOUL.md'), soul, 'utf8');
    console.log(id, 'SOUL.md applied');
  } else {
    console.log(id, 'no SOUL.md template, skip');
  }

  const destMemory = join(workspacePath, 'MEMORY.md');
  if (!existsSync(destMemory) && existsSync(memoryPath)) {
    const memory = readFileSync(memoryPath, 'utf8');
    writeFileSync(destMemory, memory, 'utf8');
    console.log(id, 'MEMORY.md created');
  } else if (existsSync(destMemory)) {
    console.log(id, 'MEMORY.md exists, left unchanged');
  }

  if (existsSync(toolsPath)) {
    const tools = readFileSync(toolsPath, 'utf8');
    writeFileSync(join(workspacePath, 'TOOLS.md'), tools, 'utf8');
    console.log(id, 'TOOLS.md applied');
  }
}

// COO also needs AGENTS.md from balserve template (ensure-coo-workspace does this)
const balserveAgents = join(TEMPLATES, 'balserve', 'AGENTS.md');
const balserveWorkspace = join(homedir, '.openclaw', 'workspace-balserve');
if (existsSync(balserveAgents) && existsSync(balserveWorkspace)) {
  const agentsMd = readFileSync(balserveAgents, 'utf8');
  writeFileSync(join(balserveWorkspace, 'AGENTS.md'), agentsMd, 'utf8');
  console.log('balserve AGENTS.md applied');
}

console.log('Done. Restart OpenClaw gateway if it is running so agents load updated SOUL/MEMORY.');
