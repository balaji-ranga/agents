/**
 * E2E: Workflow Builder brain guardrail, catalog tools, partial publish recovery.
 * Usage: node scripts/test-workflow-agent-brain-guardrail.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import { applyWorkflowBuilderActions } from '../src/services/agent-workflow-builder.js';
import { runWorkflowBuilderChat } from '../src/services/agent-workflow-agent.js';
import {
  normalizeBrainTaskConfig,
  tryCatalogQueryResponse,
  validateWorkflowForPublish,
} from '../src/services/agent-workflow-builder-catalog.js';
import * as store from '../src/services/agent-workflow-store.js';

initDb();
const owner = getBalaCeoAuthId();
const actor = { id: 'test-brain-guardrail', name: 'Test' };
const stamp = Date.now().toString(36);

function assert(name, cond, detail = '') {
  if (!cond) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`  ✓ ${name}`);
}

async function main() {
  console.log('\n=== Brain config normalization ===');
  const normalized = normalizeBrainTaskConfig({
    modelSource: 'openai',
    systemPrompt: 'Block sexual and abusive content.',
    apiKey: '',
  });
  assert('openai without key → ollama', normalized.modelSource === 'ollama');
  assert('systemPrompt preserved', normalized.systemPrompt.includes('Block sexual'));

  console.log('\n=== Catalog tools ===');
  const catalogReply = tryCatalogQueryResponse('explain brain node config');
  assert('catalog query returns brain info', /brain/i.test(catalogReply?.reply || '') && /systemPrompt/i.test(catalogReply.reply));

  console.log('\n=== Build guardrail workflow (programmatic) ===');
  const createRes = await applyWorkflowBuilderActions(owner, null, [
    {
      action: 'create_workflow',
      name: `Guardrail Brain E2E ${stamp}`,
      trigger_modes: ['manual', 'chat'],
      chat_phrase: `run guardrail ${stamp}`,
    },
    {
      action: 'add_node',
      node_type: 'brain',
      node_id: 'brain-1',
      label: 'Content Guardrail',
      connect_from: 'trigger-1',
      task_config: {
        modelSource: 'openai',
        systemPrompt:
          'You are a content safety filter. Reject or rewrite sexual, abusive, or harmful content in requests and responses. Respond professionally.\n\nUser input:\n{{input}}',
        maxTokens: 512,
      },
    },
    { action: 'validate_publish' },
    { action: 'publish' },
  ], actor);

  const wfId = createRes.workflow_id;
  assert('workflow created', !!wfId);
  assert('publish succeeded', createRes.results.some((r) => r.action === 'publish' && r.ok !== false), JSON.stringify(createRes.results));
  assert('no action errors', !createRes.has_errors, JSON.stringify(createRes.results.filter((r) => r.ok === false)));

  const def = store.getDefinition(wfId, owner);
  assert('status published', def.status === 'published');
  const brain = def.published_graph.nodes.find((n) => n.type === 'brain');
  assert('brain node exists', !!brain);
  assert('brain uses ollama (no key)', brain.data.taskConfig.modelSource === 'ollama');
  assert('guardrail prompt set', brain.data.taskConfig.systemPrompt.includes('safety'));

  const preflightErrors = validateWorkflowForPublish(def.draft_graph);
  assert('validate_publish clean', preflightErrors.length === 0, preflightErrors.join('; '));

  console.log('\n=== Partial failure recovery ===');
  await applyWorkflowBuilderActions(owner, wfId, [{ action: 'unpublish' }], actor);
  const partialRes = await applyWorkflowBuilderActions(owner, wfId, [
    { action: 'delete_node', node_id: 'trigger-1' },
    { action: 'publish' },
  ], actor);
  assert('delete saved before publish fail', !partialRes.draft_graph?.nodes?.some((n) => n.id === 'trigger-1'));
  assert('publish failed without trigger', partialRes.results.some((r) => r.action === 'publish' && r.ok === false));
  assert('has_errors flag set', partialRes.has_errors === true);

  await applyWorkflowBuilderActions(
    owner,
    wfId,
    [
      {
        action: 'add_node',
        node_type: 'trigger',
        node_id: 'trigger-1',
        label: 'Start',
        connect_from: null,
      },
      { action: 'add_edge', source: 'trigger-1', target: 'brain-1' },
      { action: 'publish' },
    ],
    actor
  );

  console.log('\n=== Chat path: catalog query ===');
  const chatRes = await runWorkflowBuilderChat({
    ownerUserId: owner,
    workflowId: wfId,
    message: 'explain brain node config fields',
    history: [],
    actor,
    persist: false,
  });
  assert('chat catalog reply', /systemPrompt|brain/i.test(chatRes.reply || ''));

  await applyWorkflowBuilderActions(owner, wfId, [{ action: 'delete_workflow' }], actor);

  console.log('\nBrain guardrail E2E passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
