/**
 * Seed: custom script + workflow (script → while → echo API x3).
 * Usage: node scripts/seed-custom-script-while-echo-workflow.js
 */
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import {
  createCustomScript,
  deleteCustomScript,
  getCustomScript,
} from '../src/services/custom-scripts.js';
import * as store from '../src/services/agent-workflow-store.js';

export const SCRIPT_ID = 'script-workflow-echo-prep';
export const WORKFLOW_NAME = 'Custom Script While Echo Test';

const owner = getBalaCeoAuthId();
const authUser = { id: owner, role: 'ceo' };
const actor = { id: 'seed-custom-script-while-echo', name: 'Seed' };

const SAMPLE_SOURCE = readFileSync(join(__dirname, 'samples', 'workflow-echo-prep.py'), 'utf8');

export function buildCustomScriptWhileEchoGraph(scriptId = SCRIPT_ID) {
  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 160 },
        data: {
          label: 'Start',
          triggerModes: ['manual'],
          chatPhrase: '',
          scheduleCron: '',
        },
      },
      {
        id: 'script-1',
        type: 'custom_script',
        position: { x: 240, y: 160 },
        data: {
          label: 'Prepare echo payload',
          inputBindings: [
            {
              id: 'payload',
              label: 'Input',
              mode: 'dynamic',
              sourceNodeId: 'trigger-1',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            customScriptId: scriptId,
            customScriptName: 'Workflow Echo Prep',
          },
        },
      },
      {
        id: 'while-1',
        type: 'while',
        position: { x: 460, y: 160 },
        data: {
          label: 'Echo 3 times',
          taskConfig: {
            sourceNodeId: 'while-1',
            sourceOutputKey: 'iterations',
            operator: 'lt',
            compareValue: '3',
            maxIterations: 10,
          },
        },
      },
      {
        id: 'api-echo',
        type: 'api',
        position: { x: 680, y: 80 },
        data: {
          label: 'Postman Echo API',
          inputBindings: [
            { id: 'url', label: 'URL', mode: 'static', value: 'https://postman-echo.com/post' },
            {
              id: 'body',
              label: 'Body',
              mode: 'dynamic',
              sourceNodeId: 'script-1',
              sourceOutputKey: 'text',
            },
            { id: 'headers', label: 'Headers', mode: 'static', value: '{"Content-Type":"application/json"}' },
          ],
          taskConfig: { method: 'POST', authType: 'none', timeoutMs: 30000 },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'script-1' },
      { id: 'e2', source: 'script-1', target: 'while-1' },
      { id: 'e3', source: 'while-1', target: 'api-echo', sourceHandle: 'loop' },
      { id: 'e4', source: 'api-echo', target: 'while-1' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

async function seedScript() {
  const existing = getCustomScript(SCRIPT_ID, authUser, { includeSource: true });
  if (existing) {
    deleteCustomScript(SCRIPT_ID, authUser);
  }
  return createCustomScript(authUser, {
    id: SCRIPT_ID,
    name: 'Workflow Echo Prep',
    description: 'Reads workflow context and prepares JSON for echo API loop',
    language: 'python',
    source: SAMPLE_SOURCE,
  });
}

async function seedWorkflow(scriptId) {
  const graph = buildCustomScriptWhileEchoGraph(scriptId);
  const existing = store.listDefinitions(owner).find((w) => w.name === WORKFLOW_NAME);
  if (existing) {
    store.deleteDefinition(existing.id, owner, actor);
  }
  const def = store.createDefinition({
    name: WORKFLOW_NAME,
    description: 'Trigger → custom script → while (3x) → Postman echo API',
    ownerUserId: owner,
    actor,
    graph,
    trigger_modes: ['manual'],
  });
  return store.publishDefinition(def.id, owner, actor);
}

async function main() {
  initDb();
  const script = await seedScript();
  console.log('Script:', script.id, script.scan_status, script.status);
  const def = await seedWorkflow(script.id);
  console.log('Workflow:', def.id, def.name, def.status);
  console.log('Graph nodes:', def.published_graph.nodes.map((n) => n.type).join(' → '));
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isCli) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
