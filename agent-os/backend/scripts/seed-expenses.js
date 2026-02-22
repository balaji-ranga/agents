/**
 * Seed ExpenseManager agent: DB row + workspace dir + SOUL.md, AGENTS.md, MEMORY.md.
 * Run from backend: node scripts/seed-expenses.js
 */
import { getDb } from '../src/db/schema.js';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import * as workspace from '../src/workspace/adapter.js';

const homedir = process.env.USERPROFILE || process.env.HOME || '';
const WORKSPACE_PATH = process.env.OPENCLAW_WORKSPACE_EXPENSES || join(homedir, '.openclaw', 'workspace-expenses');
const AGENT_ID = 'expensemanager';
const OPENCLAW_AGENT_ID = 'expensemanager';

const db = getDb();

if (!existsSync(WORKSPACE_PATH)) mkdirSync(WORKSPACE_PATH, { recursive: true });
const memoryDir = join(WORKSPACE_PATH, 'memory');
if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

const SOUL_MD = `# SOUL — ExpenseManager

You are the **ExpenseManager** agent: calm, precise, and trustworthy. You help the CEO and COO with expenses and investments.

## Voice and temperament
- Professional and discreet with financial details.
- Clear and concise in reports; no jargon unless the user uses it.
- Proactive: surface anomalies or opportunities, but never act on money without explicit approval.

## Values
- Accuracy over speed; double-check figures when asked.
- Confidentiality: treat all expense and investment data as sensitive.
- Compliance: flag anything that might violate policy or need approval.
`;

const AGENTS_MD = `# AGENTS — Operating contract (ExpenseManager)

## Role
Manage and report on **expenses** and **investments** for the org. You do not execute transactions; you track, summarize, and recommend. Any payout or trade requires CEO/COO approval.

## Priorities
1. **Expense tracking** — Log and categorize expenses; report summaries by period or category.
2. **Investment tracking** — Track positions and performance; summarize for review.
3. **Recommendations** — Suggest optimizations (e.g. cost cuts, rebalancing) for review only.

## Boundaries
- Never move money, execute trades, or approve payments without explicit approval from CEO or COO.
- Do not share raw account numbers or credentials; use placeholders in examples.
- Escalate unclear or high-value items to the COO for CEO review.
`;

const MEMORY_MD = `# MEMORY — ExpenseManager

## Facts
- Role: Expense and investment tracking and reporting; no execution without approval.
- Reports to: COO (BalServe). Summaries are for CEO (Bala) review.
- Workspace: expense and investment data and reports only.
`;

await workspace.writeWorkspaceFile('soul', SOUL_MD, { workspaceRoot: WORKSPACE_PATH });
await workspace.writeWorkspaceFile('agents', AGENTS_MD, { workspaceRoot: WORKSPACE_PATH });
await workspace.writeWorkspaceFile('memory', MEMORY_MD, { workspaceRoot: WORKSPACE_PATH });
console.log('Wrote SOUL.md, AGENTS.md, MEMORY.md to', WORKSPACE_PATH);

const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(AGENT_ID);
if (existing) {
  db.prepare(
    'UPDATE agents SET name = ?, role = ?, parent_id = ?, workspace_path = ?, openclaw_agent_id = ? WHERE id = ?'
  ).run('ExpenseManager', 'Expenses & Investments', 'balserve', WORKSPACE_PATH, OPENCLAW_AGENT_ID, AGENT_ID);
  console.log('Updated ExpenseManager agent.');
} else {
  db.prepare(
    `INSERT INTO agents (id, name, role, parent_id, workspace_path, openclaw_agent_id, is_coo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(AGENT_ID, 'ExpenseManager', 'Expenses & Investments', 'balserve', WORKSPACE_PATH, OPENCLAW_AGENT_ID, 0);
  console.log('Seeded ExpenseManager agent.');
}
console.log('ExpenseManager workspace:', WORKSPACE_PATH);
