import { randomUUID } from 'crypto';
import { fetchAgentCard, a2aSendMessage } from '../src/services/a2a-client.js';

const CARD_URL = 'https://hello-world-gxfr.onrender.com/.well-known/agent.json';
const endpoint = 'https://hello-world-gxfr.onrender.com/';

async function rawRpc(method, params) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const { card } = await fetchAgentCard(CARD_URL);
console.log('Card:', card.name, card.url);

const attempts = [
  ['message/send', { message: { role: 'user', parts: [{ kind: 'text', text: 'hello world' }] } }],
  ['message/send', { message: { role: 'user', parts: [{ type: 'text', text: 'hello world' }] } }],
  [
    'message/send',
    {
      message: { role: 'user', parts: [{ type: 'text', text: 'hello world' }] },
      metadata: { skillId: 'hello_world' },
    },
  ],
  [
    'message/send',
    {
      message: { role: 'user', parts: [{ type: 'text', text: 'hello world' }] },
      configuration: { acceptedOutputModes: ['text'] },
    },
  ],
  [
    'SendMessage',
    {
      message: { role: 'user', parts: [{ type: 'text', text: 'hello world' }] },
    },
  ],
];

for (const [method, params] of attempts) {
  console.log('\n---', method, JSON.stringify(params).slice(0, 120));
  const { status, text } = await rawRpc(method, params);
  console.log('status', status, text.slice(0, 500));
}

try {
  const r = await a2aSendMessage(endpoint, 'hello world', { skillId: 'hello_world' });
  console.log('\nclient ok', r.text, r.taskState);
} catch (e) {
  console.log('\nclient err', e.message);
}
