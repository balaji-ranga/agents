/**
 * Sandboxed JS custom script runner — subprocess only, JSON stdin/stdout.
 * User script must export: async function run(inputs, context) => { text, ... }
 */
import { pathToFileURL } from 'url';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TIMEOUT_MS = Number(process.env.CUSTOM_SCRIPT_TIMEOUT_MS) || 60000;

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const { source, inputs = {}, context = {} } = payload;

  const dir = mkdtempSync(join(tmpdir(), 'aos-script-'));
  const scriptPath = join(dir, 'user-script.mjs');
  const wrapped = `${source}

export default typeof run !== 'undefined' ? run : undefined;
`;
  writeFileSync(scriptPath, wrapped, 'utf8');

  try {
    const mod = await import(pathToFileURL(scriptPath).href);
    const fn = mod.default || mod.run;
    if (typeof fn !== 'function') {
      throw new Error('Script must export run(inputs, context)');
    }
    const result = await Promise.race([
      fn(inputs, context),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Script timeout')), TIMEOUT_MS)),
    ]);
    const out = result && typeof result === 'object' ? result : { text: String(result ?? '') };
    process.stdout.write(JSON.stringify({ ok: true, output: out }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message || String(e) }));
    process.exitCode = 1;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

main();
