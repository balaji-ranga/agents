/**
 * Install the agent-os-content-tools OpenClaw plugin (extension) so the gateway registers
 * summarize_url, generate_image, generate_video as tools. Run from agent-os: node scripts/install-agent-os-content-tools-extension.js
 * Copies openclaw-extensions/agent-os-content-tools to ~/.openclaw/extensions/agent-os-content-tools
 */
import { join } from 'path';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENT_OS_ROOT = join(__dirname, '..');
const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_EXTENSIONS = join(USERPROFILE, '.openclaw', 'extensions');
const SOURCE = join(AGENT_OS_ROOT, 'openclaw-extensions', 'agent-os-content-tools');

if (!existsSync(SOURCE)) {
  console.error('Source not found:', SOURCE);
  process.exit(1);
}

const destDir = join(OPENCLAW_EXTENSIONS, 'agent-os-content-tools');
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
console.log('Installed agent-os-content-tools extension to', destDir);
console.log('Next: run node scripts/apply-openclaw-agents-config.js to enable the plugin and tools in openclaw.json, then restart the gateway.');
console.log('Set plugins.entries["agent-os-content-tools"].config.baseUrl (e.g. http://127.0.0.1:3001) or AGENT_OS_API_URL so the tools can call the backend.');
