import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb } from '../src/db/schema.js';
import { advanceFromNode } from '../src/services/agent-workflow-runner.js';
import * as store from '../src/services/agent-workflow-store.js';
import { getBalaCeoAuthId } from '../src/services/job-applicant-ceo.js';

const runId = Number(process.argv[2] || 282);
initDb();
const CEO = getBalaCeoAuthId();

const before = store.getRun(runId, CEO);
console.log('Before:', before?.status, before?.progress_pct, before?.steps?.map((s) => `${s.node_id}:${s.status}`));

await advanceFromNode(runId, 'trigger-1');

const after = store.getRun(runId, CEO);
console.log('After:', after?.status, after?.progress_pct, after?.steps?.map((s) => `${s.node_id}:${s.status}`));
if (after?.steps) {
  const script = after.steps.find((s) => s.node_id === 'script-1');
  if (script) console.log('Script output:', script.output);
}
