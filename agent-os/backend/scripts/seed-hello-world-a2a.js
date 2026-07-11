/**
 * Register Hello World A2A agent (a2aregistry / Render demo) and seed test workflow.
 * Usage: node scripts/seed-hello-world-a2a.js
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';
import {
  createExternalAgent,
  discoverExternalAgent,
  getExternalAgent,
} from '../src/services/external-agents.js';
import * as store from '../src/services/agent-workflow-store.js';

initDb();

export const HELLO_WORLD_AGENT_ID = 'a2a-hello-world-agent';
export const HELLO_WORLD_CARD_URL = 'https://hello-world-gxfr.onrender.com/.well-known/agent.json';
export const HELLO_WORLD_WORKFLOW_NAME = 'Hello World A2A Test';

const owner = getBalaCeoAuthId();
const authUser = { id: owner, role: 'ceo' };

export function buildHelloWorldA2AGraph(externalAgentId = HELLO_WORLD_AGENT_ID) {
  return {
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 40, y: 120 },
        data: {
          label: 'Start',
          triggerModes: ['manual', 'chat'],
          chatPhrase: 'run hello world a2a',
          scheduleCron: '',
        },
      },
      {
        id: 'a2a-1',
        type: 'externalAgent',
        position: { x: 280, y: 120 },
        data: {
          label: 'Hello World A2A',
          inputBindings: [
            {
              id: 'message',
              label: 'Message / prompt',
              mode: 'dynamic',
              sourceNodeId: 'trigger-1',
              sourceOutputKey: 'text',
            },
          ],
          taskConfig: {
            externalAgentId,
            externalAgentName: 'Hello World Agent',
            skillId: 'hello_world',
            waitForCompletion: true,
            timeoutMs: 120000,
          },
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger-1', target: 'a2a-1' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export async function seedHelloWorldA2A({ publish = true } = {}) {
  let agent = getExternalAgent(HELLO_WORLD_AGENT_ID, authUser);
  if (!agent) {
    agent = createExternalAgent(authUser, {
      id: HELLO_WORLD_AGENT_ID,
      name: 'Hello World Agent',
      description: 'A2A demo from hello-world-gxfr.onrender.com (a2aregistry)',
      card_url: HELLO_WORLD_CARD_URL,
      skill_id: 'hello_world',
    });
  }
  agent = await discoverExternalAgent(HELLO_WORLD_AGENT_ID, authUser);
  console.log('External agent:', agent.id, agent.status, agent.endpoint_url);

  const actor = { id: 'seed-hello-world-a2a', name: 'Seed Script' };
  const graph = buildHelloWorldA2AGraph(HELLO_WORLD_AGENT_ID);

  let def = store.listDefinitions(owner).find((w) => w.name === HELLO_WORLD_WORKFLOW_NAME);

  if (!def) {
    def = store.createDefinition({
      name: HELLO_WORLD_WORKFLOW_NAME,
      description: 'Trigger → external A2A Hello World agent',
      ownerUserId: owner,
      actor,
      graph,
      trigger_modes: ['manual', 'chat'],
      chat_trigger_phrase: 'run hello world a2a',
    });
    console.log('Created workflow:', def.id);
  } else {
    def = store.updateDraft(def.id, owner, { graph, description: def.description }, actor);
    console.log('Updated workflow draft:', def.id);
  }

  if (publish) {
    def = store.publishDefinition(def.id, owner, actor);
    if (!def) throw new Error(`Failed to publish workflow ${def?.id}`);
    console.log('Published workflow:', def.status);
  }

  return { agent, workflow: def };
}

if (process.argv[1]?.includes('seed-hello-world-a2a')) {
  seedHelloWorldA2A()
    .then(({ agent, workflow }) => {
      console.log('Done.', { agent_id: agent.id, workflow_id: workflow.id, status: workflow.status });
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
