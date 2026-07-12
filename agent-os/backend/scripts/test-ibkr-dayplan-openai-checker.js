/**
 * Cancel stuck run 328, switch Checker to OpenAI for reliability, run full day-plan E2E.
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import {
  startAgentWorkflowRun,
  completeCeoApprovalResponse,
} from '../src/services/agent-workflow-runner.js';
import * as store from '../src/services/agent-workflow-store.js';
import { pauseRun } from '../src/services/agent-workflow-run-manager.js';
import {
  seedIbkrMakerCheckerWorkflow,
  WORKFLOW_ID,
} from './seed-ibkr-maker-checker-workflow.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import { IBKR_DAY_PLAN_VARIABLES } from './ibkr-workflow-variables.js';

initDb();
const db = getDb();
const ownerUserId = getBalaCeoAuthId();
const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_PRIMARY_API_KEY || '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function summarize(run) {
  for (const s of run.steps || []) {
    console.log(`  ${s.node_id} i${s.iteration} ${s.status}${s.error_message ? ' ' + s.error_message : ''}`);
  }
}

async function waitFor(runId, pred, { timeoutMs = 420000, label = 'cond' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const run = store.getRun(runId, ownerUserId);
    if (pred(run)) return run;
    if (['failed', 'completed', 'paused', 'cancelled'].includes(run.status) && !pred(run)) return run;
    await sleep(2500);
  }
  throw new Error(`Timeout: ${label}`);
}

function patchCheckerToOpenAi(graph) {
  const checker = graph.nodes.find((n) => n.id === 'checker-1');
  if (!checker) throw new Error('checker-1 missing');
  checker.data.taskConfig = {
    ...checker.data.taskConfig,
    modelSource: 'openai',
    apiEndpoint: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: openaiKey,
    model: process.env.OPENAI_PRIMARY_MODEL || 'gpt-4o-mini',
    maxTokens: 2048,
  };
  return graph;
}

async function main() {
  console.log('=== Day-plan retest (OpenAI checker) ===');
  const backend = (process.env.AGENT_OS_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const h = await fetch(`${backend}/health`, { signal: AbortSignal.timeout(4000) });
  if (!h.ok) throw new Error('backend down');

  console.log('\n=== Pause stuck run 328 if still active ===');
  try {
    const paused = pauseRun(328, ownerUserId, { id: 'e2e', name: 'E2E' }, 'stuck ollama checker — e2e cancel');
    console.log('328 status', paused?.status);
  } catch (e) {
    console.warn('pause 328:', e.message);
  }

  console.log('\n=== Seed + patch Checker → OpenAI ===');
  await seedIbkrMakerCheckerWorkflow(ownerUserId, { publish: true });
  const def = store.getDefinition(WORKFLOW_ID, ownerUserId);
  const graph = patchCheckerToOpenAi(JSON.parse(JSON.stringify(def.draft_graph || def.published_graph)));
  store.updateDraft(
    WORKFLOW_ID,
    ownerUserId,
    { graph, variables: { ...IBKR_DAY_PLAN_VARIABLES, ...(def.variables || {}) } },
    { id: 'e2e', name: 'E2E openai checker' }
  );
  store.publishDefinition(WORKFLOW_ID, ownerUserId, { id: 'e2e', name: 'E2E openai checker' });
  store.setPaused(WORKFLOW_ID, ownerUserId, false, { id: 'e2e', name: 'E2E' });

  const pub = store.getDefinition(WORKFLOW_ID, ownerUserId);
  const chk = (pub.published_graph || pub.draft_graph).nodes.find((n) => n.id === 'checker-1');
  console.log('Checker source/model', chk?.data?.taskConfig?.modelSource, chk?.data?.taskConfig?.model);

  try {
    const { spawnSync } = await import('child_process');
    spawnSync(process.execPath, [join(__dirname, 'reset-ibkr-day-reservations.js')], {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
      env: process.env,
    });
  } catch {
    /* ignore */
  }

  console.log('\n=== Start day plan ===');
  const run = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'manual',
    input:
      'Prepare today paper day plan for allowlist names within $1000 budget. Prefer liquid US equities; honor order_learnings avoid_hints (skip paper PAXOS crypto).',
    actor: { id: 'e2e', name: 'E2E Dayplan' },
  });
  console.log('Run', run.id);

  let latest = await waitFor(
    run.id,
    (r) => {
      if (['failed', 'paused', 'cancelled'].includes(r.status)) return true;
      const ceo = r.steps?.find((s) => s.node_id === 'ceo-day');
      if (ceo && ['in_progress', 'listening', 'awaiting', 'completed'].includes(ceo.status)) return true;
      return !!db
        .prepare(
          `SELECT id FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? LIMIT 1`
        )
        .get(`%agent_wf_run_id: ${r.id}%`, '%node_type: ceo_approval%');
    },
    { timeoutMs: 480000, label: 'CEO or fail' }
  );

  console.log('\n=== Mid status ===', latest.status);
  summarize(latest);

  // Feedback inspection
  const makers = db
    .prepare(
      `SELECT iteration, output_json FROM agent_workflow_run_steps WHERE run_id=? AND node_id='maker-1' ORDER BY id`
    )
    .all(run.id);
  const parses = db
    .prepare(
      `SELECT iteration, output_json FROM agent_workflow_run_steps WHERE run_id=? AND node_id='parse-checker' ORDER BY id`
    )
    .all(run.id);
  for (const p of parses) {
    const o = JSON.parse(p.output_json || '{}');
    console.log(`parse i${p.iteration}: ${o.decision} | ${String(o.adjustments || '').slice(0, 140)}`);
  }
  for (const m of makers) {
    const o = JSON.parse(m.output_json || '{}');
    const um = o.user_message_preview || '';
    console.log(
      `maker i${m.iteration}: feedbackInUserMsg=${/^=== CHECKER FEEDBACK/m.test(um)} planKeys=${JSON.stringify(
        (() => {
          try {
            return (JSON.parse(o.text || '{}').trades || []).map((t) => t.key);
          } catch {
            return [];
          }
        })()
      )}`
    );
  }

  if (['failed', 'paused', 'cancelled'].includes(latest.status)) {
    console.error('TEST FAILED before CEO');
    process.exit(1);
  }

  let ceoKanban = db
    .prepare(
      `SELECT id, title FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? ORDER BY id DESC LIMIT 1`
    )
    .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');
  for (let i = 0; i < 40 && !ceoKanban; i++) {
    await sleep(2000);
    ceoKanban = db
      .prepare(
        `SELECT id, title FROM kanban_tasks WHERE description LIKE ? AND description LIKE ? ORDER BY id DESC LIMIT 1`
      )
      .get(`%agent_wf_run_id: ${run.id}%`, '%node_type: ceo_approval%');
  }
  if (!ceoKanban) {
    console.error('No CEO kanban');
    process.exit(1);
  }

  console.log('\n=== CEO approve ===', ceoKanban.id);
  await completeCeoApprovalResponse({
    kanbanTaskId: ceoKanban.id,
    decision: 'approve',
    comment: 'E2E day-plan approve',
    actor: { id: ownerUserId, name: 'CEO E2E' },
  });

  latest = await waitFor(
    run.id,
    (r) =>
      ['completed', 'failed'].includes(r.status) ||
      r.steps?.some((s) => s.node_id === 'api-place' && ['completed', 'failed'].includes(s.status)),
    { timeoutMs: 240000, label: 'place' }
  );

  console.log('\n=== Final ===', latest.status);
  summarize(latest);
  const place = latest.steps?.find((s) => s.node_id === 'api-place');
  if (place) {
    const raw = place.output ?? place.output_json;
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
    const body = o.body || o;
    console.log('Place result', {
      placed: body.placed,
      message: body.message,
      error: body.error,
      results: (body.gateway_results || []).map((r) => ({
        key: r.key,
        ok: r.ok,
        orderIds: r.orderIds,
        terminal_cancelled: r.terminal_cancelled,
        terminal_reason_text: (r.terminal_reason_text || '').slice(0, 100),
        error: r.error,
      })),
    });
  }

  // Restore ollama checker in published graph for normal ops
  await seedIbkrMakerCheckerWorkflow(ownerUserId, { publish: true });
  console.log('\nRestored seeded Checker (Ollama) via re-seed');

  if (latest.status === 'failed') process.exit(1);
  console.log('\nTEST PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
