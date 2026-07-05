/**
 * Append browser tool instructions to every agent workspace TOOLS.md under ~/.openclaw.
 * Run: node scripts/sync-browser-tools-md.js
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const homedir = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(homedir, '.openclaw');

const BROWSER_SECTION = `
---

## Browser automation (OpenClaw + Playwright)

You have the **browser** tool for web automation (navigate, snapshot, click, type, screenshot).

- **Always use \`profile="openclaw"\`** — the managed Playwright/Chromium browser. Do **not** use \`profile="chrome"\` unless the user explicitly asks to attach their Chrome tab via the Browser Relay extension.
- Typical flow: \`browser\` action start (profile openclaw) → open URL → snapshot → act using refs from snapshot.
- If browser fails, report the error; do not ask the user to install the Chrome extension unless they requested chrome profile.
`;

const MARKER = '## Browser automation (OpenClaw + Playwright)';

function patchToolsMd(path) {
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '# TOOLS\n';
  if (text.includes(MARKER)) {
    const start = text.indexOf(MARKER);
    const next = text.indexOf('\n---\n', start + 1);
    const end = next >= 0 ? next : text.length;
    text = text.slice(0, start) + BROWSER_SECTION.trimStart() + (next >= 0 ? text.slice(next) : '\n');
  } else {
    text = text.trimEnd() + BROWSER_SECTION;
  }
  writeFileSync(path, text.endsWith('\n') ? text : text + '\n', 'utf8');
  console.log('Updated', path);
}

const dirs = readdirSync(OPENCLAW_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (d.name === 'workspace' || d.name.startsWith('workspace-')))
  .map((d) => join(OPENCLAW_DIR, d.name));

for (const dir of dirs) {
  patchToolsMd(join(dir, 'TOOLS.md'));
}

// Repo templates
const templatesRoot = join(process.cwd(), 'openclaw-workspace-templates');
if (existsSync(templatesRoot)) {
  for (const name of readdirSync(templatesRoot, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    patchToolsMd(join(templatesRoot, name.name, 'TOOLS.md'));
  }
}

console.log('Done syncing browser TOOLS.md sections');
