/**
 * Ensure OpenClaw agent dirs exist for balserve and techresearcher so the gateway
 * can run them (sessions + auth). Run from agent-os: node scripts/ensure-openclaw-agent-dirs.js
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const AGENTS_ROOT = join(USERPROFILE, '.openclaw', 'agents');

const AGENT_IDS = ['bala', 'balserve', 'techresearcher', 'expensemanager'];

for (const id of AGENT_IDS) {
  const agentDir = join(AGENTS_ROOT, id, 'agent');
  const sessionsDir = join(AGENTS_ROOT, id, 'sessions');
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'auth.json'), '{}', 'utf8');
    console.log('Created', agentDir);
  }
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), '{}', 'utf8');
    console.log('Created', sessionsDir);
  }
}
console.log('Agent dirs OK for', AGENT_IDS.join(', '));
