/**
 * Install the agent-os-content-tools skill into OpenClaw shared skills so all agents can use it.
 * Run from agent-os: node scripts/install-agent-os-content-tools-skill.js
 * Copies openclaw-skills/agent-os-content-tools to ~/.openclaw/skills/agent-os-content-tools
 */
import { join } from 'path';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_SKILLS = join(USERPROFILE, '.openclaw', 'skills');
const SOURCE = join(AGENT_OS_ROOT, 'openclaw-skills', 'agent-os-content-tools');

if (!existsSync(SOURCE)) {
  console.error('Source not found:', SOURCE);
  process.exit(1);
}

const destDir = join(OPENCLAW_SKILLS, 'agent-os-content-tools');
if (!existsSync(OPENCLAW_SKILLS)) mkdirSync(OPENCLAW_SKILLS, { recursive: true });
if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

function copyRecursive(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyRecursive(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

copyRecursive(SOURCE, destDir);
console.log('Installed agent-os-content-tools skill to', destDir);
console.log('All agents will see it via ~/.openclaw/skills. Restart the gateway if it is running.');
console.log('Set AGENT_OS_API_URL (and optionally TOOLS_API_KEY) where OpenClaw/skill runs so the backend can be called.');
