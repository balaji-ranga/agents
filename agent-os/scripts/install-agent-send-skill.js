/**
 * Install the agent-send skill into OpenClaw shared skills so all agents can use it.
 * Run from agent-os: node scripts/install-agent-send-skill.js
 * Copies openclaw-skills/agent-send to ~/.openclaw/skills/agent-send
 */
import { join } from 'path';
import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_SKILLS = join(USERPROFILE, '.openclaw', 'skills');
const SOURCE = join(AGENT_OS_ROOT, 'openclaw-skills', 'agent-send');

if (!existsSync(SOURCE)) {
  console.error('Source not found:', SOURCE);
  process.exit(1);
}

const destDir = join(OPENCLAW_SKILLS, 'agent-send');
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
console.log('Installed agent-send skill to', destDir);
console.log('All agents (Bala, COO, TechResearcher, ExpenseManager) will see it via ~/.openclaw/skills. Restart the gateway if it is running.');
