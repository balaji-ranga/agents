/**
 * Seed IBKR maker/checker paper day-plan workflow.
 * Usage: node scripts/seed-ibkr-maker-checker-workflow.js
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
import { ensureIbkrLedgerTables } from '../src/services/ibkr-trading-ledger.js';
import { getIbkrTradingConfig } from '../src/services/ibkr-trading-rules.js';
import { IBKR_DAY_PLAN_VARIABLES } from './ibkr-workflow-variables.js';

export const WORKFLOW_ID = 'ibkr-maker-checker-paper';
export const CHAT_PHRASE = 'run ibkr day plan';
export const PARSE_SCRIPT_ID = 'script-ibkr-parse-checker';

const cfg = {
  ...getIbkrTradingConfig(),
  makerModel: process.env.OPENAI_PRIMARY_MODEL || process.env.OPENAI_COO_MODEL || 'gpt-4o-mini',
  checkerModel: process.env.OLLAMA_MODEL || 'llama3.2',
};
const backendBase = (process.env.AGENT_OS_API_URL || process.env.BACKEND_URL || 'http://127.0.0.1:3001').replace(
  /\/$/,
  ''
);

const MAKER_PROMPT = `You are the Maker for an IBKR paper day plan. Output ONLY valid JSON (no markdown).

=== CHECKER REVISION RULES (highest priority on retries) ===
Checker feedback is also injected at the TOP of the user message when present.
- If Checker feedback is non-empty: you MUST revise the previous plan to address EACH point.
- Do not repeat the same plan with only cosmetic note changes.
- If a Checker request conflicts with hard constraints (allowlist-only, order_learnings avoid_hints, cash/budget): keep the constraint, explain why in notes, and still improve what you can (justification quality, residual reasons, sizing).
- An empty trades[] day is valid when allowlist names are blocked by order_learnings / IB system cancels — say so explicitly in notes and residual.
- Honor BRAIN HISTORY (prior maker/checker summaries) in the user message — do not repeat past reject patterns.

You MAY pick a SUBSET of the allowlist — do NOT feel obliged to trade every name.
Prefer 1–3 best ideas that fit cash + budget. Put overflow ideas in residual.

Workflow allowlist (full instrument meta): {{var.allowlist}}
Allowlist keys: {{var.allowlist_keys}}
Markets: {{var.markets}}
Daily budget USD: {{var.daily_budget_usd}}
Max trades/day: {{var.max_trades_per_day}}

Hard constraints:
- Keys MUST be from allowlist_keys / allowlist only (do not invent tickers)
- Side: BUY or SELL_TO_CLOSE only (no shorting)
- Respect each instrument board_lot / sec_type from allowlist (fractional crypto, SGX lots, etc.)
- stop_pct in [{{var.stop_pct_min}}, {{var.stop_pct_max}}]; tp_pct in [{{var.tp_pct_min}}, {{var.tp_pct_max}}] for BUY
- BUY entry ≤ reference_price + {{var.entry_slip_pct_max}}%
- Respect cash/positions/pending sells/reference_prices from account snapshot in the user message
- When snapshot.reference_prices[key].reference_price is present, USE it as reference_price (do not invent)
- Read snapshot.order_learnings (last 30d): honor avoid_hints and summary_bullets — do not repeat IB system cancels (e.g. paper crypto/PAXOS unavailable, margin calc unsupported)
- If already long a name, do not BUY again; use SELL_TO_CLOSE only to exit
- If an SGX board lot does not fit budget, skip that name and use other allowlist markets

Each BUY trade MUST include rich justification for the Checker:
- thesis (≥1 sentence, 1–3 month trend)
- catalysts (what could work in your favor)
- risks (what could go wrong)
- why_now (why today vs wait)
- rationale (short summary)
Combined justification must be substantial (≥{{var.min_rationale_chars}} chars).

Schema:
{
  "trades": [
    {
      "key": "NASDAQ:NVDA",
      "side": "BUY",
      "qty": 1,
      "reference_price": 100,
      "entry_price": 100.1,
      "stop_pct": 1.8,
      "tp_pct": 1.2,
      "thesis": "...",
      "catalysts": "...",
      "risks": "...",
      "why_now": "...",
      "rationale": "..."
    }
  ],
  "residual": [],
  "notes": "day thesis / why this subset / how you addressed checker feedback"
}

Latest Checker adjustments (may be empty on first pass): {{parse-checker.adjustments}}
`;

const CHECKER_PROMPT = `You are the Checker (risk reviewer). Output ONLY valid JSON:
{"decision":"approved"|"rejected","adjustments":"...","notes":"..."}

The Maker plan is in the user message (not only here). Also use any order_learnings / snapshot excerpts in the user message.

Approve when:
- trades[] is empty AND notes/residual clearly cite snapshot.order_learnings / prior IB system cancels (e.g. paper PAXOS unavailable, margin calc unsupported) — valid informed no-trade day
- OR each BUY has solid thesis/risks/why_now and respects allowlist {{var.allowlist_keys}}, cash, stops, and learnings

Reject if:
- symbol outside allowlist {{var.allowlist_keys}}
- weak/missing thesis, risks, or why_now on non-empty trades
- stop/tp/entry rules look wrong
- ignores cash, open positions, pending sells, or order_learnings avoid_hints (e.g. repeats PAXOS after ib_system_cancel)
- empty trades[] with NO explanation of why (vague skip)
- Maker ignored your previous adjustments without explaining why

On reject: adjustments MUST be a non-empty, concrete, actionable string (what to change). Never leave adjustments empty.
Do not ask for symbols outside the allowlist.
`;

export function buildIbkrMakerCheckerGraph({ parseScriptId = PARSE_SCRIPT_ID } = {}) {
  const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_PRIMARY_API_KEY || '';
  const ollamaBase = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const ollamaEndpoint = ollamaBase.endsWith('/v1') ? ollamaBase : `${ollamaBase}/v1`;
  const checkerModel = cfg.checkerModel || process.env.OLLAMA_MODEL || 'llama3.2';
  const maxLoops = Number(IBKR_DAY_PLAN_VARIABLES.checker_max_loops) || 3;

  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 200 },
        data: {
          label: 'Start day plan',
          triggerModes: ['manual', 'chat'],
          chatPhrase: CHAT_PHRASE,
          scheduleCron: '',
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
                '{"daily_budget_usd":{{var.daily_budget_usd}},"max_trades_per_day":{{var.max_trades_per_day}},"allowlist":{{var.allowlist}},"allowlist_keys":{{var.allowlist_keys}},"require_live_cash":{{var.require_live_cash}},"block_duplicate_buys":{{var.block_duplicate_buys}},"min_rationale_chars":{{var.min_rationale_chars}}}',
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
        id: 'api-preflight',
        type: 'api',
        position: { x: 440, y: 200 },
        data: {
          label: 'Preflight budget+cash',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/ibkr-trading/preflight` },
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
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 60000 },
        },
      },
      {
        id: 'if-preflight',
        type: 'if',
        position: { x: 640, y: 200 },
        data: {
          label: 'Preflight ok?',
          taskConfig: {
            sourceNodeId: 'api-preflight',
            sourceOutputKey: 'body.ok',
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
                purpose: 'IBKR day-plan Maker learning from prior maker/checker Brain audits',
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
        id: 'while-checker',
        type: 'while',
        position: { x: 900, y: 120 },
        data: {
          label: 'Maker↔Checker loop',
          taskConfig: {
            sourceNodeId: 'parse-checker',
            sourceOutputKey: 'decision',
            operator: 'ne',
            compareValue: 'approved',
            maxIterations: maxLoops,
          },
        },
      },
      {
        id: 'maker-1',
        type: 'brain',
        position: { x: 1120, y: 40 },
        data: {
          label: 'Maker (OpenAI)',
          inputBindings: [
            {
              id: 'userMessage',
              mode: 'static',
              value:
                '=== CHECKER FEEDBACK (address every point on retries; empty on first pass) ===\n{{parse-checker.adjustments}}\n\n=== BRAIN HISTORY (prior maker/checker learnings, summarized) ===\n{{api-brain-history.body.context_text}}\n\n=== ACCOUNT SNAPSHOT (cash, positions, open orders, order_learnings) ===\n{{api-snapshot.bodyText}}\n\n=== RUN REQUEST ===\n{{input}}',
            },
          ],
          taskConfig: {
            modelSource: 'openai',
            apiEndpoint: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            apiKey: openaiKey,
            model: cfg.makerModel,
            maxTokens: 4096,
            systemPrompt: MAKER_PROMPT,
            mcpToolCalling: false,
            mcpServerIds: [],
            mcpToolAllowlist: [],
            mcpMaxToolRounds: 4,
            httpHeadersJson: '{}',
          },
        },
      },
      {
        id: 'checker-1',
        type: 'brain',
        position: { x: 1280, y: 40 },
        data: {
          label: 'Checker (Ollama)',
          inputBindings: [
            {
              id: 'userMessage',
              mode: 'static',
              value:
                '=== MAKER PLAN (JSON) ===\n{{maker-1.text}}\n\n=== ORDER LEARNINGS (honor these; do not demand blocked symbols) ===\n{{api-snapshot.order_learnings}}\n\n=== ALLOWLIST KEYS ===\n{{var.allowlist_keys}}',
            },
          ],
          taskConfig: {
            modelSource: 'ollama',
            apiEndpoint: ollamaEndpoint,
            apiKey: '',
            model: checkerModel,
            maxTokens: 2048,
            systemPrompt: CHECKER_PROMPT,
            mcpToolCalling: false,
            mcpServerIds: [],
            mcpToolAllowlist: [],
            mcpMaxToolRounds: 4,
            httpHeadersJson: '{}',
          },
        },
      },
      {
        id: 'parse-checker',
        type: 'custom_script',
        position: { x: 1500, y: 40 },
        data: {
          label: 'Parse checker decision',
          inputBindings: [
            {
              id: 'text',
              mode: 'dynamic',
              sourceNodeId: 'checker-1',
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
        id: 'if-checker',
        type: 'if',
        position: { x: 1060, y: 280 },
        data: {
          label: 'Checker approved?',
          taskConfig: {
            sourceNodeId: 'parse-checker',
            sourceOutputKey: 'decision',
            operator: 'eq',
            compareValue: 'approved',
          },
        },
      },
      {
        id: 'api-validate',
        type: 'api',
        position: { x: 1280, y: 280 },
        data: {
          label: 'Validate plan',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/ibkr-trading/validate-plan` },
            {
              id: 'body',
              mode: 'dynamic',
              sourceNodeId: 'maker-1',
              sourceOutputKey: 'text',
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
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 60000 },
        },
      },
      {
        id: 'ceo-day',
        type: 'ceo_approval',
        position: { x: 1500, y: 280 },
        data: {
          label: 'CEO day-plan approval',
          inputBindings: [
            {
              id: 'summary',
              mode: 'dynamic',
              sourceNodeId: 'api-validate',
              sourceOutputKey: 'bodyText',
            },
          ],
          taskConfig: {
            title: 'Approve IBKR day plan (paper)',
            prompt: 'Review validated day plan and approve or reject.',
          },
        },
      },
      {
        id: 'if-ceo',
        type: 'if',
        position: { x: 1720, y: 280 },
        data: {
          label: 'CEO approved?',
          taskConfig: {
            sourceNodeId: 'ceo-day',
            sourceOutputKey: 'decision',
            operator: 'eq',
            compareValue: 'approved',
          },
        },
      },
      {
        id: 'api-place',
        type: 'api',
        position: { x: 1940, y: 200 },
        data: {
          label: 'Reserve + place (Gateway)',
          inputBindings: [
            { id: 'url', mode: 'static', value: `${backendBase}/api/ibkr-trading/place` },
            {
              id: 'body',
              mode: 'dynamic',
              sourceNodeId: 'api-validate',
              sourceOutputKey: 'bodyText',
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
      {
        id: 'brain-reject',
        type: 'brain',
        position: { x: 1280, y: 420 },
        data: {
          label: 'Rejected / failed note',
          inputBindings: [
            {
              id: 'userMessage',
              mode: 'dynamic',
              sourceNodeId: 'trigger-1',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            modelSource: 'ollama',
            apiEndpoint: ollamaEndpoint,
            apiKey: '',
            model: checkerModel,
            maxTokens: 256,
            systemPrompt: 'Summarize why the IBKR day plan stopped in one short sentence.',
            mcpToolCalling: false,
            mcpServerIds: [],
          },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'api-snapshot' },
      { id: 'e2', source: 'api-snapshot', target: 'api-preflight' },
      { id: 'e3', source: 'api-preflight', target: 'if-preflight' },
      { id: 'e4', source: 'if-preflight', target: 'api-brain-history', sourceHandle: 'true' },
      { id: 'e4b', source: 'api-brain-history', target: 'while-checker' },
      { id: 'e5', source: 'if-preflight', target: 'brain-reject', sourceHandle: 'false' },
      { id: 'e6', source: 'while-checker', target: 'maker-1', sourceHandle: 'loop' },
      { id: 'e7', source: 'maker-1', target: 'checker-1' },
      { id: 'e8', source: 'checker-1', target: 'parse-checker' },
      { id: 'e9', source: 'parse-checker', target: 'while-checker' },
      { id: 'e10', source: 'while-checker', target: 'if-checker', sourceHandle: 'exit' },
      { id: 'e11', source: 'if-checker', target: 'api-validate', sourceHandle: 'true' },
      { id: 'e12', source: 'if-checker', target: 'brain-reject', sourceHandle: 'false' },
      { id: 'e13', source: 'api-validate', target: 'ceo-day' },
      { id: 'e14', source: 'ceo-day', target: 'if-ceo' },
      { id: 'e15', source: 'if-ceo', target: 'api-place', sourceHandle: 'true' },
      { id: 'e16', source: 'if-ceo', target: 'brain-reject', sourceHandle: 'false' },
    ],
  };
}

async function seedParseScript(authUser) {
  const source = readFileSync(join(__dirname, 'samples', 'ibkr-parse-checker.js'), 'utf8');
  const existing = getCustomScript(PARSE_SCRIPT_ID, authUser, { includeSource: true });
  if (existing) deleteCustomScript(PARSE_SCRIPT_ID, authUser);
  return createCustomScript(authUser, {
    id: PARSE_SCRIPT_ID,
    name: 'IBKR Parse Checker',
    description: 'Parse Maker/Checker JSON decision for while/if gates',
    language: 'javascript',
    source,
  });
}

function upsertWorkflow(ownerUserId, actor, patch) {
  const existing = store.getDefinition(WORKFLOW_ID, ownerUserId);
  if (existing) {
    return store.updateDraft(WORKFLOW_ID, ownerUserId, patch, actor);
  }
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
      JSON.stringify(patch.graph),
      '',
      CHAT_PHRASE,
      'manual,chat',
      JSON.stringify(patch.variables || {})
    );
  store.appendAudit(WORKFLOW_ID, {
    action: 'created',
    summary: `Created workflow "${patch.name}"`,
    changedBy: actor.id,
    changedByName: actor.name,
  });
  return store.getDefinition(WORKFLOW_ID, ownerUserId);
}

export async function seedIbkrMakerCheckerWorkflow(ownerUserId, { publish = true } = {}) {
  initDb();
  ensureIbkrLedgerTables();
  const authUser = { id: ownerUserId, role: 'ceo' };
  const actor = { id: 'seed-ibkr', name: 'Seed IBKR' };
  const script = await seedParseScript(authUser);
  const graph = buildIbkrMakerCheckerGraph({ parseScriptId: script.id });
  const patch = {
    name: 'IBKR Maker/Checker Paper',
    description:
      'Paper day plan: snapshot(cash/positions/orders) → preflight → maker↔checker → CEO → validate/place',
    graph,
    trigger_modes: ['manual', 'chat'],
    schedule_cron: '',
    chat_trigger_phrase: CHAT_PHRASE,
    variables: IBKR_DAY_PLAN_VARIABLES,
  };
  upsertWorkflow(ownerUserId, actor, patch);
  let def;
  if (publish) {
    try {
      def = store.publishDefinition(WORKFLOW_ID, ownerUserId, actor);
    } catch (e) {
      console.warn('Publish deferred (set Brain API keys):', e.message);
      def = store.getDefinition(WORKFLOW_ID, ownerUserId);
    }
  } else {
    def = store.getDefinition(WORKFLOW_ID, ownerUserId);
  }
  notifySchedulerConfigurationChanged();
  return { def, script };
}

async function main() {
  const owner = getBalaCeoAuthId();
  const { def, script } = await seedIbkrMakerCheckerWorkflow(owner, { publish: true });
  console.log('Script:', script.id, script.scan_status, script.status);
  console.log('Workflow:', def?.id, def?.name, def?.status);
  console.log('Variables:', JSON.stringify(def?.variables));
  console.log('Chat phrase:', CHAT_PHRASE);
}

const isCli =
  process.argv[1] &&
  (process.argv[1].includes('seed-ibkr-maker-checker-workflow') ||
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')));
if (isCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
