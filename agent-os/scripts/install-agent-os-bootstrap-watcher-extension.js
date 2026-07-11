/**
 * Install agent-os-bootstrap-watcher OpenClaw plugin.
 * Run from agent-os: node scripts/install-agent-os-bootstrap-watcher-extension.js
 */
import { join } from 'path';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
import { fileURLToPath } from 'url';
import { resolveOpenClawExtensionsDir } from './lib/openclaw-paths.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const OPENCLAW_EXTENSIONS = resolveOpenClawExtensionsDir();
const SOURCE = join(AGENT_OS_ROOT, 'openclaw-extensions', 'agent-os-bootstrap-watcher');

if (!existsSync(SOURCE)) {
  console.error('Source not found:', SOURCE);
  process.exit(1);
}

const destDir = join(OPENCLAW_EXTENSIONS, 'agent-os-bootstrap-watcher');
if (!existsSync(OPENCLAW_EXTENSIONS)) mkdirSync(OPENCLAW_EXTENSIONS, { recursive: true });
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
console.log('Installed agent-os-bootstrap-watcher extension to', destDir);
console.log('Next: node scripts/apply-openclaw-agents-config.js then restart the gateway.');
