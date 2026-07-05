/**
 * Direct test of intent classifier against Llama (Ollama): no server required.
 * Loads backend .env, uses COO AGENTS.md content, calls classifyIntentAndAllocate.
 * Usage: node scripts/test-intent-llama-direct.js
 * Prereq: Ollama running with OPENAI_PRIMARY_MODEL (e.g. llama3.2).
 */
import { config } from 'dotenv';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyIntentAndAllocate, getLastIntentDebug } from '../src/services/intent-classifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const AGENTS_MD_PATH = join(__dirname, '..', '..', 'openclaw-workspace-templates', 'balserve', 'AGENTS.md');
const PROMPT = 'do a deep research on Space tech';

async function main() {
  const baseUrl = process.env.OPENAI_PRIMARY_BASE_URL || '';
  const model = process.env.OPENAI_PRIMARY_MODEL || '(default)';
  console.log('LLM base URL:', baseUrl || '(default)');
  console.log('LLM model:', model);
  if (/localhost|127\.0\.0\.1/.test(baseUrl)) console.log('Using local Ollama (Llama) for intent classification.');
  console.log('Prompt:', PROMPT);
  console.log('');

  let agentsMd;
  try {
    agentsMd = await readFile(AGENTS_MD_PATH, 'utf8');
  } catch (e) {
    console.error('Could not read AGENTS.md:', e.message);
    process.exit(1);
  }

  const result = await classifyIntentAndAllocate(PROMPT, agentsMd);
  const debug = getLastIntentDebug();

  console.log('Result:', result === null ? 'null' : JSON.stringify(result, null, 2));
  if (debug?.error) console.log('Intent debug error:', debug.error);
  if (debug?.modelRawResponse) console.log('Model raw (first 400 chars):', String(debug.modelRawResponse).slice(0, 400));
  console.log('Final mapping:', JSON.stringify(debug?.finalMapping ?? {}, null, 2));

  const agentsTagged = result && typeof result === 'object' ? Object.keys(result) : [];
  const onlyTechResearcher = agentsTagged.length === 1 && agentsTagged[0].toLowerCase() === 'techresearcher';

  if (onlyTechResearcher) {
    console.log('\nPASS: Intent classifier reached Llama and tagged only TechResearcher.');
  } else {
    console.log('\nFAIL: Expected only techresearcher, got:', agentsTagged);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
