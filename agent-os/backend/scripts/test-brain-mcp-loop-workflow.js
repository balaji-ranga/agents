/**
 * E2E: Brain node with MCP tool-calling loop — LLM picks get_random_number / emit_random_event.
 *
 * Prerequisites:
 *   - Local MCP: node tools/local-mcp-random-sse/server.js
 *   - MCP seeded: node backend/scripts/seed-local-mcp-random-sse.js
 *   - LLM: Ollama @ 11434 (default) OR set BRAIN_MCP_TEST_PROVIDER=openai + OPENAI_API_KEY
 *
 * Run: node backend/scripts/test-brain-mcp-loop-workflow.js
 */
import { config } from 'dotenv';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import * as store from '../src/services/agent-workflow-store.js';
import { startAgentWorkflowRun } from '../src/services/agent-workflow-runner.js';
import { connectMcpServer } from '../src/services/mcp-servers.js';
import { resolveBrainProviderConfig } from '../src/services/agent-workflow-brain-providers.js';
import { seedBrainMcpLoopWorkflow, WORKFLOW_ID, MCP_ID, buildBrainMcpLoopGraph } from './seed-brain-mcp-loop-workflow.js';

initDb();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseStepOutput(step) {
  if (!step?.output) return null;
  return typeof step.output === 'string' ? JSON.parse(step.output) : step.output;
}

function toolCallsFromOutput(out) {
  if (!out) return [];
  if (Array.isArray(out.mcp_tool_calls)) return out.mcp_tool_calls;
  const list = out.outputs || [];
  const tc = list.find((o) => o.id === 'mcp_tool_calls');
  if (!tc?.value) return [];
  try {
    return JSON.parse(tc.value);
  } catch {
    return [];
  }
}

async function checkLlm() {
  const brainCfg = buildBrainMcpLoopGraph().nodes.find((n) => n.id === 'brain-1').data.taskConfig;
  const { baseUrl, apiKey, model, requiresKey } = resolveBrainProviderConfig(brainCfg.modelSource, brainCfg);
  const url = `${baseUrl.replace(/\/$/, '')}/models`.replace('/v1/models', '/api/tags');
  if (brainCfg.modelSource === 'ollama') {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!r?.ok) throw new Error('Ollama not reachable at http://127.0.0.1:11434 — start Ollama or set BRAIN_MCP_TEST_PROVIDER=openai');
    const data = await r.json().catch(() => ({}));
    const names = (data.models || []).map((m) => m.name);
    console.log('Ollama models:', names.slice(0, 5).join(', ') || '(none listed)');
    console.log('Using model:', model);
    return { provider: 'ollama', model };
  }
  if (requiresKey && !apiKey) throw new Error(`${brainCfg.modelSource} requires API key in .env`);
  console.log('LLM provider:', brainCfg.modelSource, 'model:', model);
  return { provider: brainCfg.modelSource, model };
}

async function ensureMcp(admin) {
  const health = await fetch('http://127.0.0.1:3099/health').catch(() => null);
  if (!health?.ok) {
    throw new Error('Local MCP not running — start: node tools/local-mcp-random-sse/server.js');
  }
  const row = getDb().prepare('SELECT id FROM mcp_servers WHERE id = ?').get(MCP_ID);
  if (!row) {
    throw new Error(`MCP ${MCP_ID} not registered — run: node backend/scripts/seed-local-mcp-random-sse.js`);
  }
  await connectMcpServer(MCP_ID, admin);
}

async function main() {
  const ownerUserId = process.env.WORKFLOW_SEED_OWNER_ID || process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';
  const admin = getDb().prepare(`SELECT id, role FROM platform_users WHERE role = 'admin' LIMIT 1`).get();

  console.log('=== Prerequisites ===');
  await checkLlm();
  await ensureMcp(admin);

  console.log('\n=== Seed workflow ===');
  const def = seedBrainMcpLoopWorkflow(ownerUserId, { publish: true });
  store.setPaused(WORKFLOW_ID, ownerUserId, false, { id: 'test', name: 'Test' });
  console.log('Workflow:', def.id);

  console.log('\n=== Start run ===');
  const run = await startAgentWorkflowRun(WORKFLOW_ID, ownerUserId, {
    trigger: 'manual',
    input: 'Run MCP tool loop test',
    actor: { id: 'test', name: 'Brain MCP test', type: 'system' },
  });
  console.log('Run #' + run.run_number, 'id=' + run.id);

  let latest = store.getRun(run.id, ownerUserId);
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    latest = store.getRun(run.id, ownerUserId);
    const brain = latest.steps?.find((s) => s.node_id === 'brain-1');
    if (brain?.status === 'completed' || brain?.status === 'failed') break;
    if (i % 5 === 0) console.log('  … brain status:', brain?.status || 'pending');
  }

  const brainStep = latest.steps?.find((s) => s.node_id === 'brain-1');
  const out = parseStepOutput(brainStep);
  const toolCalls = toolCallsFromOutput(out);

  console.log('\n=== Brain step ===');
  console.log('Status:', brainStep?.status);
  if (brainStep?.error_message) console.log('Error:', brainStep.error_message);
  console.log('MCP tools available:', out?.mcp_tools_available ?? out?.outputs?.find((o) => o.id === 'mcp_tools_available')?.value);
  console.log('Tool calls:', JSON.stringify(toolCalls, null, 2));
  console.log('Response text:', (out?.text || '').slice(0, 500));

  const toolNames = toolCalls.map((t) => t.toolName).filter(Boolean);
  const checks = [
    ['brain step completed', brainStep?.status === 'completed'],
    ['at least one MCP tool call', toolCalls.length >= 1],
    ['get_random_number invoked', toolNames.includes('get_random_number')],
    ['all tool calls succeeded', toolCalls.every((t) => t.ok !== false)],
    ['run completed', latest.status === 'completed'],
  ];

  const emitCalled = toolNames.includes('emit_random_event');
  console.log('\nemit_random_event called:', emitCalled, '(expected only when LLM saw odd parity)');

  console.log('\n--- Assertions ---');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(ok ? '  ✓' : '  ✗', label);
    if (!ok) failed++;
  }

  if (failed) process.exit(1);
  console.log('\nBrain MCP tool-loop test passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
