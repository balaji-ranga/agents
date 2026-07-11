/**
 * Run user custom scripts in an isolated subprocess with timeout.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_JS = join(__dirname, '../../scripts/custom-script-sandbox.mjs');
const SANDBOX_PY = join(__dirname, '../../scripts/custom-script-sandbox.py');

const TIMEOUT_MS = Number(process.env.CUSTOM_SCRIPT_TIMEOUT_MS) || 60000;
const PYTHON_BIN = process.env.CUSTOM_SCRIPT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const NODE_BIN = process.env.CUSTOM_SCRIPT_NODE || 'node';

function runSubprocess(cmd, args, stdinPayload) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CUSTOM_SCRIPT_TIMEOUT_MS: String(TIMEOUT_MS),
        PYTHONDONTWRITEBYTECODE: '1',
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        child.kill('SIGTERM');
      }
      finish({ ok: false, error: `Script timed out after ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS + 2000);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(line);
        if (parsed.ok) finish({ ok: true, output: parsed.output });
        else finish({ ok: false, error: parsed.error || stderr || 'Script failed' });
      } catch {
        finish({
          ok: false,
          error: stderr.trim() || stdout.trim() || `Script exited with code ${code}`,
        });
      }
    });
    child.stdin.write(JSON.stringify(stdinPayload));
    child.stdin.end();
  });
}

export async function runCustomScriptInSandbox({
  source,
  language = 'python',
  runtimeProfile = 'restricted',
  inputs = {},
  context = {},
}) {
  const lang = String(language).toLowerCase();
  const payload = { source, inputs, context, runtimeProfile };

  if (lang === 'javascript' || lang === 'js') {
    return runSubprocess(NODE_BIN, [SANDBOX_JS], payload);
  }
  if (lang === 'python') {
    return runSubprocess(PYTHON_BIN, [SANDBOX_PY], payload);
  }
  return { ok: false, error: `Unsupported language: ${language}` };
}
