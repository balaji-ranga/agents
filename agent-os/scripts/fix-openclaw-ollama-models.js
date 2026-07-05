/**
 * Ensure ~/.openclaw/openclaw.json has models.providers.ollama.models as an array
 * of model objects (OpenClaw expects objects, not strings). Run: node scripts/fix-openclaw-ollama-models.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const configPath = join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const ollama = config.models?.providers?.ollama;

function modelObject(id) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 81920,
  };
}

function isValidModelEntry(m) {
  return m && typeof m === 'object' && typeof m.id === 'string';
}

if (!ollama) {
  console.log('No ollama provider in config.');
  process.exit(0);
}

if (!Array.isArray(ollama.models) || ollama.models.length === 0 || !isValidModelEntry(ollama.models[0])) {
  ollama.models = [modelObject('llama3.2')];
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log('Fixed: set models.providers.ollama.models to [{ id: "llama3.2", ... }]');
} else {
  console.log('OK: ollama.models already valid', ollama.models.map((m) => m.id));
}
