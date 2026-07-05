/**
 * Run intent classifier with a given message and print system prompt, user message, and model response.
 * Run from backend: node scripts/run-intent-debug.js "Create an indian cuisine with recipe & image also i need a deep tech research on space science"
 * Requires: .env with OPENAI_API_KEY; COO and AGENTS.md in place.
 */
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { getDb } from '../src/db/schema.js';
import { classifyIntentAndAllocate } from '../src/services/intent-classifier.js';

process.env.DEBUG_INTENT = '1';

const message = process.argv[2] || 'Create an indian cuisine with recipie &image also i need a deep tech research on space science';

async function readCooAgentsMd() {
  const db = getDb();
  const coo = db.prepare('SELECT workspace_path FROM agents WHERE is_coo = 1 LIMIT 1').get();
  if (!coo?.workspace_path) return '';
  try {
    return await readFile(join(coo.workspace_path, 'AGENTS.md'), 'utf8');
  } catch (_) {
    return '';
  }
}

async function main() {
  const agentsMd = await readCooAgentsMd();
  if (!agentsMd.trim()) {
    console.error('No COO AGENTS.md found. Ensure backend DB is seeded and COO workspace has AGENTS.md.');
    process.exit(1);
  }
  console.log('\n--- CEO message (input) ---\n', message, '\n');
  const result = await classifyIntentAndAllocate(message, agentsMd);
  console.log('\n--- Result (agent_id -> redacted message) ---\n', result === null ? 'null (error)' : result, '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
