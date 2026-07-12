/**
 * Seed IBKR position poller workflow (every 15 minutes).
 * Usage: node scripts/seed-ibkr-poller-workflow.js
 */
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import {
  createCustomScript,
  deleteCustomScript,
  getCustomScript,
} from '../src/services/custom-scripts.js';
import * as store from '../src/services/agent-workflow-store.js';
import { notifySchedulerConfigurationChanged } from '../src/services/agent-workflow-scheduler.js';
import { getIbkrTradingConfig } from '../src/services/ibkr-trading-rules.js';
import { ensureIbkrLedgerTables } from '../src/services/ibkr-trading-ledger.js';
import { IBKR_POLLER_VARIABLES } from './ibkr-workflow-variables.js';

export const WORKFLOW_ID = 'ibkr-position-poller-paper';
export const PARSE_SCRIPT_ID = 'script-ibkr-parse-checker';
export const PARSE_EXIT_SCRIPT_ID = 'script-ibkr-parse-exit-reviews';

const cfg = {
  ...getIbkrTradingConfig(),
  makerModel: process.env.OPENAI_PRIMARY_MODEL || process.env.OPENAI_COO_MODEL || 'gpt-4o-mini',
  checkerModel: process.env.OLLAMA_MODEL || 'llama3.2',
};
const backendBase = (process.env.AGENT_OS_API_URL || process.env.BACKEND_URL || 'http://127.0.0.1:3001').replace(
  /\/$/,
  ''
);

const MAKER_PROMPT = `You are the Maker for IBKR max-hold exit review. Output ONLY valid JSON.

=== CHECKER REVISION RULES ===
Checker feedback is injected at the TOP of the user message when present.
- If feedback is non-empty: revise EACH review to address it; do not only rephrase notes.
- If a request conflicts with max_hold / allowlist / order_learnings: keep the rule and explain in rationale.
- Honor BRAIN HISTORY summaries in the user message — avoid repeating past reject themes.

Positions at/over max_hold_days ({{var.max_hold_days}}) need a decision: SELL_TO_CLOSE or HOLD.
HOLD may extend by at most {{var.max_hold_extension_days}} days (field extend_days).
Allowlist (instruments): {{var.allowlist}}
Allowlist keys: {{var.allowlist_keys}}

Use snapshot.order_learnings from the user message (last 30d cancel/fill reasons). Prefer exits that acknowledge prior IB cancel patterns when relevant.

For each candidate provide detailed justification (thesis/risks/why_now style) so Checker can review.

Schema:
{
  "reviews": [
    {
      "key": "NASDAQ:NVDA",
      "decision": "SELL_TO_CLOSE"|"HOLD",
      "qty": 2,
      "entry_price": 100.0,
      "reference_price": 100.0,
      "extend_days": 0,
      "thesis": "...",
      "risks": "...",
      "why_now": "...",
      "rationale": "..."
    }
  ],
  "notes": "..."
}

Latest Checker adjustments (may be empty on first pass): {{parse-exit.adjustments}}
`;

const CHECKER_PROMPT = `You are the Checker for exit reviews. Output ONLY valid JSON:
{"decision":"approved"|"rejected","adjustments":"...","notes":"..."}

Maker reviews are in the user message. Approve only if each SELL/HOLD has clear justification.
Reject vague HOLDs that dodge max_hold_days={{var.max_hold_days}}.
On reject: adjustments MUST be a non-empty concrete actionable string.
`;

export function buildIbkrPollerGraph({ parseScriptId = PARSE_SCRIPT_ID, parseExitId = PARSE_EXIT_SCRIPT_ID } = {}) {
  const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_PRIMARY_API_KEY || '';
  const ollamaBase = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const ollamaEndpoint = ollamaBase.endsWith('/v1') ? ollamaBase : `${ollamaBase}/v1`;
  const checkerModel = cfg.checkerModel || process.env.OLLAMA_MODEL || 'llama3.2';
  const maxLoops = Number(IBKR_POLLER_VARIABLES.checker_max_loops) || 3;

  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 200 },
        data: {
          label: 'Poll trigger',
          triggerModes: ['manual', 'schedule'],
          chatPhrase: '',
          scheduleCron: '*/15 * * * *',
        },
      },
      {
        id: 'api-snapshot',
        type: 'api',
        position: { x: 240, y: 200 },
        data: {
          label: 'Account snapshot',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/ibkr-trading/account-snapshot` },
            {
              id: 'body',
              mode: 'static',
              value:
                '{"daily_budget_usd":{{var.daily_budget_usd}},"max_trades_per_day":{{var.max_trades_per_day}},"allowlist":{{var.allowlist}},"allowlist_keys":{{var.allowlist_keys}}}',
            },
            {
              id: 'headers',
              mode: 'static',
              value: JSON.stringify({ 'Content-Type': 'application/json', 'x-internal-test': '1' }),
            },
          ],
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 90000 },
        },
      },
      {
        id: 'api-candidates',
        type: 'api',
        position: { x: 440, y: 200 },
        data: {
          label: 'Exit candidates',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/ibkr-trading/exit-candidates?max_hold_days=${IBKR_POLLER_VARIABLES.max_hold_days}` },
            {
              id: 'body',
              mode: 'dynamic',
              sourceNodeId: 'api-snapshot',
              sourceOutputKey: 'bodyText',
            },
            {
              id: 'headers',
              mode: 'static',
              value: JSON.stringify({ 'Content-Type': 'application/json', 'x-internal-test': '1' }),
            },
          ],
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 30000 },
        },
      },
      {
        id: 'if-candidates',
        type: 'if',
        position: { x: 640, y: 200 },
        data: {
          label: 'Any aged positions?',
          taskConfig: {
            sourceNodeId: 'api-candidates',
            sourceOutputKey: 'body.has_candidates',
            operator: 'eq',
            compareValue: 'true',
          },
        },
      },
      {
        id: 'api-brain-history',
        type: 'api',
        position: { x: 740, y: 120 },
        data: {
          label: 'Brain history (summarized)',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/agent-workflows/brain-history` },
            {
              id: 'body',
              mode: 'static',
              value: JSON.stringify({
                workflow_id: ['ibkr-maker-checker-paper', 'ibkr-position-poller-paper'],
                node_id: ['maker-1', 'checker-1', 'maker-exit', 'checker-exit'],
                days: '{{var.brain_history_days}}',
                response_type: 'summarized',
                limit: 40,
                purpose: 'IBKR poller Maker learning from prior maker/checker Brain audits',
              }).replace('"{{var.brain_history_days}}"', '{{var.brain_history_days}}'),
            },
            {
              id: 'headers',
              mode: 'static',
              value: JSON.stringify({ 'Content-Type': 'application/json', 'x-internal-test': '1' }),
            },
          ],
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 120000 },
        },
      },
      {
        id: 'while-exit',
        type: 'while',
        position: { x: 900, y: 120 },
        data: {
          label: 'Exit maker↔checker',
          taskConfig: {
            sourceNodeId: 'parse-exit',
            sourceOutputKey: 'decision',
            operator: 'ne',
            compareValue: 'approved',
            maxIterations: maxLoops,
          },
        },
      },
      {
        id: 'maker-exit',
        type: 'brain',
        position: { x: 1120, y: 40 },
        data: {
          label: 'Maker exit review',
          inputBindings: [
            {
              id: 'userMessage',
              mode: 'static',
              value:
                '=== CHECKER FEEDBACK (address every point on retries; empty on first pass) ===\n{{parse-exit.adjustments}}\n\n=== BRAIN HISTORY (prior maker/checker learnings, summarized) ===\n{{api-brain-history.body.context_text}}\n\n=== EXIT CANDIDATES / SNAPSHOT ===\n{{api-candidates.bodyText}}\n\nAccount snapshot learnings:\n{{api-snapshot.order_learnings}}\n\n=== RUN REQUEST ===\n{{input}}',
            },
          ],
          taskConfig: {
            modelSource: 'openai',
            apiEndpoint: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            apiKey: openaiKey,
            model: cfg.makerModel,
            maxTokens: 3072,
            systemPrompt: MAKER_PROMPT,
            mcpToolCalling: false,
            mcpServerIds: [],
          },
        },
      },
      {
        id: 'checker-exit',
        type: 'brain',
        position: { x: 1340, y: 40 },
        data: {
          label: 'Checker exit review',
          inputBindings: [
            {
              id: 'userMessage',
              mode: 'static',
              value:
                '=== MAKER EXIT REVIEWS ===\n{{maker-exit.text}}\n\n=== ORDER LEARNINGS ===\n{{api-snapshot.order_learnings}}',
            },
          ],
          taskConfig: {
            modelSource: 'ollama',
            apiEndpoint: ollamaEndpoint,
            apiKey: '',
            model: checkerModel,
            maxTokens: 1024,
            systemPrompt: CHECKER_PROMPT,
            mcpToolCalling: false,
            mcpServerIds: [],
          },
        },
      },
      {
        id: 'parse-exit',
        type: 'custom_script',
        position: { x: 1500, y: 40 },
        data: {
          label: 'Parse exit checker',
          inputBindings: [
            {
              id: 'text',
              mode: 'dynamic',
              sourceNodeId: 'checker-exit',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            customScriptId: parseScriptId,
            customScriptName: 'IBKR Parse Checker',
          },
        },
      },
      {
        id: 'if-exit-approved',
        type: 'if',
        position: { x: 1060, y: 280 },
        data: {
          label: 'Exit plan approved?',
          taskConfig: {
            sourceNodeId: 'parse-exit',
            sourceOutputKey: 'decision',
            operator: 'eq',
            compareValue: 'approved',
          },
        },
      },
      {
        id: 'script-build-sells',
        type: 'custom_script',
        position: { x: 1280, y: 280 },
        data: {
          label: 'Build SELL trades + HOLDs',
          inputBindings: [
            {
              id: 'text',
              mode: 'dynamic',
              sourceNodeId: 'maker-exit',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            customScriptId: parseExitId,
            customScriptName: 'IBKR Parse Exit Reviews',
          },
        },
      },
      {
        id: 'if-has-sells',
        type: 'if',
        position: { x: 1500, y: 280 },
        data: {
          label: 'Any sells?',
          taskConfig: {
            sourceNodeId: 'script-build-sells',
            sourceOutputKey: 'has_sells',
            operator: 'eq',
            compareValue: 'true',
          },
        },
      },
      {
        id: 'api-record-holds',
        type: 'api',
        position: { x: 1500, y: 400 },
        data: {
          label: 'Record HOLD extensions',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/ibkr-trading/record-holds-batch` },
            {
              id: 'body',
              mode: 'dynamic',
              sourceNodeId: 'script-build-sells',
              sourceOutputKey: 'holds_body',
            },
            {
              id: 'headers',
              mode: 'static',
              value: JSON.stringify({
                'Content-Type': 'application/json',
                'x-internal-test': '1',
              }),
            },
          ],
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 30000 },
        },
      },
      {
        id: 'api-place-sells',
        type: 'api',
        position: { x: 1720, y: 200 },
        data: {
          label: 'Place SELL_TO_CLOSE',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/ibkr-trading/place` },
            {
              id: 'body',
              mode: 'dynamic',
              sourceNodeId: 'script-build-sells',
              sourceOutputKey: 'place_body',
            },
            {
              id: 'headers',
              mode: 'static',
              value: JSON.stringify({
                'Content-Type': 'application/json',
                'x-internal-test': '1',
              }),
            },
          ],
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 120000 },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'api-snapshot' },
      { id: 'e2', source: 'api-snapshot', target: 'api-candidates' },
      { id: 'e3', source: 'api-candidates', target: 'if-candidates' },
      { id: 'e4', source: 'if-candidates', target: 'api-brain-history', sourceHandle: 'true' },
      { id: 'e4b', source: 'api-brain-history', target: 'while-exit' },
      { id: 'e5', source: 'while-exit', target: 'maker-exit', sourceHandle: 'loop' },
      { id: 'e6', source: 'maker-exit', target: 'checker-exit' },
      { id: 'e7', source: 'checker-exit', target: 'parse-exit' },
      { id: 'e8', source: 'parse-exit', target: 'while-exit' },
      { id: 'e9', source: 'while-exit', target: 'if-exit-approved', sourceHandle: 'exit' },
      { id: 'e10', source: 'if-exit-approved', target: 'script-build-sells', sourceHandle: 'true' },
      { id: 'e11', source: 'script-build-sells', target: 'api-record-holds' },
      { id: 'e12', source: 'api-record-holds', target: 'if-has-sells' },
      { id: 'e13', source: 'if-has-sells', target: 'api-place-sells', sourceHandle: 'true' },
    ],
  };
}

async function seedExitScript(authUser) {
  const source = readFileSync(join(__dirname, 'samples', 'ibkr-parse-exit-reviews.js'), 'utf8');
  const existing = getCustomScript(PARSE_EXIT_SCRIPT_ID, authUser, { includeSource: true });
  if (existing) deleteCustomScript(PARSE_EXIT_SCRIPT_ID, authUser);
  return createCustomScript(authUser, {
    id: PARSE_EXIT_SCRIPT_ID,
    name: 'IBKR Parse Exit Reviews',
    description: 'Split maker exit reviews into SELL trades + HOLD records',
    language: 'javascript',
    source,
  });
}

export async function seedIbkrPollerWorkflow(ownerUserId, { publish = true } = {}) {
  initDb();
  ensureIbkrLedgerTables();
  const authUser = { id: ownerUserId, role: 'ceo' };
  const actor = { id: 'seed-ibkr-poller', name: 'Seed IBKR Poller' };
  const exitScript = await seedExitScript(authUser);
  const graph = buildIbkrPollerGraph({
    parseScriptId: PARSE_SCRIPT_ID,
    parseExitId: exitScript.id,
  });
  const patch = {
    name: 'IBKR Position Poller Paper',
    description:
      'Every 15m: snapshot → aged positions (≥ max_hold_days) → maker/checker SELL|HOLD → place sells',
    graph,
    trigger_modes: ['manual', 'schedule'],
    schedule_cron: '*/15 * * * *',
    chat_trigger_phrase: '',
    variables: IBKR_POLLER_VARIABLES,
  };

  const existing = store.getDefinition(WORKFLOW_ID, ownerUserId);
  if (existing) {
    store.updateDraft(WORKFLOW_ID, ownerUserId, patch, actor);
  } else {
    getDb()
      .prepare(
        `INSERT INTO agent_workflow_definitions (id, name, description, owner_user_id, draft_graph_json, status, schedule_cron, chat_trigger_phrase, trigger_modes, variables_json)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
      )
      .run(
        WORKFLOW_ID,
        patch.name,
        patch.description,
        ownerUserId,
        JSON.stringify(graph),
        patch.schedule_cron,
        '',
        'manual,schedule',
        JSON.stringify(patch.variables)
      );
    store.appendAudit(WORKFLOW_ID, {
      action: 'created',
      summary: `Created workflow "${patch.name}"`,
      changedBy: actor.id,
      changedByName: actor.name,
    });
  }

  let def;
  if (publish) {
    try {
      def = store.publishDefinition(WORKFLOW_ID, ownerUserId, actor);
    } catch (e) {
      console.warn('Publish deferred:', e.message);
      def = store.getDefinition(WORKFLOW_ID, ownerUserId);
    }
  } else {
    def = store.getDefinition(WORKFLOW_ID, ownerUserId);
  }
  notifySchedulerConfigurationChanged();
  return { def, exitScript };
}

async function main() {
  const owner = getBalaCeoAuthId();
  const { def, exitScript } = await seedIbkrPollerWorkflow(owner, { publish: true });
  console.log('Exit script:', exitScript.id, exitScript.status);
  console.log('Workflow:', def?.id, def?.name, def?.status, def?.schedule_cron);
  console.log('Variables:', JSON.stringify(def?.variables));
}

const isCli =
  process.argv[1] &&
  (process.argv[1].includes('seed-ibkr-poller-workflow') ||
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')));
if (isCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
