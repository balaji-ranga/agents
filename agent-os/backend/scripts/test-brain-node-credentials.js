/**
 * Verify workflow Brain nodes do not fall back to platform .env API keys.
 * Usage: node scripts/test-brain-node-credentials.js
 */
import { initDb } from '../src/db/schema.js';
import {
  resolveWorkflowBrainProviderConfig,
  resolveBrainProviderConfig,
  validateWorkflowBrainCredentials,
} from '../src/services/agent-workflow-brain-providers.js';
import { executeBrainTask } from '../src/services/agent-workflow-brain.js';

initDb();

process.env.OPENAI_API_KEY = 'sk-platform-should-not-be-used';

const cfg = { modelSource: 'openai', apiEndpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

const workflowResolved = resolveWorkflowBrainProviderConfig('openai', cfg);
const platformResolved = resolveBrainProviderConfig('openai', cfg);

if (workflowResolved.configuredKey || workflowResolved.apiKey) {
  throw new Error('workflow resolver should not have key without node config');
}
if (!platformResolved.apiKey) {
  throw new Error('platform resolver should still read env for non-workflow use');
}

const graph = {
  nodes: [
    {
      id: 'brain-1',
      type: 'brain',
      data: { label: 'Test', taskConfig: { modelSource: 'openai', apiEndpoint: 'https://api.openai.com/v1' } },
    },
  ],
};
const errors = validateWorkflowBrainCredentials(graph);
if (!errors.length) throw new Error('expected validation errors for missing apiKey');

let threw = false;
try {
  await executeBrainTask(cfg, { userMessage: 'hi' }, {}, {}, { authUser: { id: 'ceo-bala', role: 'ceo' } });
} catch (e) {
  threw = true;
  if (!/required on Brain node/i.test(e.message)) throw new Error(`unexpected error: ${e.message}`);
}
if (!threw) throw new Error('executeBrainTask should fail without node apiKey');

console.log('OK: workflow Brain uses node keys only; platform env fallback preserved for non-workflow code');
