/**
 * Delete all agent workflow run instances for the CEO user.
 * Run: node backend/scripts/cleanup-workflow-runs.js
 */
import { config } from 'dotenv';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { initDb, getDb } from '../src/db/schema.js';
import { deleteAllRuns } from '../src/services/agent-workflow-run-manager.js';

initDb();

const ceoId = process.env.WORKFLOW_SEED_OWNER_ID || process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala';
const before = getDb().prepare('SELECT COUNT(*) AS n FROM agent_workflow_runs').get()?.n ?? 0;

const result = deleteAllRuns(ceoId, {
  actor: { id: 'cleanup-script', name: 'Cleanup script', type: 'system' },
});

const after = getDb().prepare('SELECT COUNT(*) AS n FROM agent_workflow_runs').get()?.n ?? 0;
console.log(`Deleted ${result.deleted} run(s). Before: ${before}, after: ${after}.`);

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(0);
}
