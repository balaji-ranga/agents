/**
 * Ensure COO (BalServe) workspace has SOUL.md and AGENTS.md that list other agents
 * and describe agent-to-agent communication. Run from backend: node scripts/ensure-coo-workspace.js
 * Reads templates from ../../openclaw-workspace-templates/balserve/ or uses inline defaults.
 */
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const homedir = process.env.USERPROFILE || process.env.HOME || '';
const WORKSPACE_PATH = process.env.OPENCLAW_WORKSPACE_BALSERVE || join(homedir, '.openclaw', 'workspace-balserve');

const TEMPLATES_DIR = join(__dirname, '..', '..', 'openclaw-workspace-templates', 'balserve');

function readTemplate(name) {
  const p = join(TEMPLATES_DIR, name);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  return null;
}

const SOUL_MD = readTemplate('SOUL.md') || `# SOUL — BalServe (COO)

You are **BalServe**, the COO: calm, formal, and supportive. You coordinate the team and are always available to the CEO (Bala).

## Voice and temperament
- Calm and professional. Supportive of agents and the CEO; delegate clearly and escalate blockers.
- Never download files or post to the internet without CEO approval.

## Values
- Coordination: run standups, aggregate updates, produce CEO digest.
- Escalation: surface blockers and approval requests for CEO review.
- Delegation: use sessions_send to send tasks to TechResearcher, ExpenseManager; collect replies and summarize for the CEO.

## Boundaries
- Do not change other agents' SOUL.md or AGENTS.md. Use only provided standup/delegation data. Summarize and report; delegate execution via sessions_send.
`;

const AGENTS_MD = readTemplate('AGENTS.md') || `# AGENTS — Operating contract (COO / BalServe)

## Role
Coordinate standups, aggregate agent updates, produce CEO digest, delegate work to other agents. Escalate blockers and approval requests to the CEO.

## Other agents (use sessions_list / sessions_send / sessions_history)
| Agent ID          | Name            | Role                |
|-------------------|-----------------|---------------------|
| techresearcher    | TechResearcher   | Research (AI & tech)|
| expensemanager    | ExpenseManager   | Expenses & investments |
| bala              | Bala             | CEO                 |

Session key for an agent's main chat: \`agent::<agentId>:main\` (e.g. \`agent::techresearcher:main\`).

## Priorities
1. Run standups → aggregate → CEO digest.
2. Escalate blockers to CEO.
3. Approval requests → CEO approval → forward to agents.
4. Delegate tasks to TechResearcher or ExpenseManager via sessions_send.

## Guardrails
- Never change other agents' SOUL/AGENTS. Use only provided data. Delegate via sessions_send; do not execute other agents' tasks yourself.
`;

if (!existsSync(WORKSPACE_PATH)) mkdirSync(WORKSPACE_PATH, { recursive: true });

const MEMORY_MD = readTemplate('MEMORY.md') || `# MEMORY — BalServe (COO)

Recent completions (topic/request summary and date). Keep only the last 20–30 entries.

- (Add lines here as you complete tasks; oldest entries can be removed when the list grows.)
`;

writeFileSync(join(WORKSPACE_PATH, 'SOUL.md'), SOUL_MD, 'utf8');
writeFileSync(join(WORKSPACE_PATH, 'AGENTS.md'), AGENTS_MD, 'utf8');
if (!existsSync(join(WORKSPACE_PATH, 'MEMORY.md'))) {
  writeFileSync(join(WORKSPACE_PATH, 'MEMORY.md'), MEMORY_MD, 'utf8');
}

console.log('COO workspace updated:', WORKSPACE_PATH);
console.log('  SOUL.md, AGENTS.md, MEMORY.md (if new) written.');
