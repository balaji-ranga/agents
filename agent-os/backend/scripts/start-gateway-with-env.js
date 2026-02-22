/**
 * Start OpenClaw gateway with env from backend .env (so OPENAI_API_KEY is available).
 * Run from backend: node scripts/start-gateway-with-env.js
 */
import { config } from 'dotenv';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const port = process.env.OPENCLAW_GATEWAY_PORT || '18789';
const child = spawn('openclaw', ['gateway', '--port', port], {
  env: process.env,
  stdio: 'inherit',
  shell: true,
  cwd: join(__dirname, '..', '..'),
});
child.on('exit', (code) => process.exit(code ?? 0));
