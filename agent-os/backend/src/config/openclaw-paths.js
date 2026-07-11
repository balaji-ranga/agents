/**
 * Resolve OpenClaw state directory for backend runtime (~/.openclaw or OPENCLAW_DIR).
 */
import { join } from 'path';

export function getOpenClawDir() {
  if (process.env.OPENCLAW_DIR) return process.env.OPENCLAW_DIR;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, '.openclaw');
}

export function getOpenClawConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH || join(getOpenClawDir(), 'openclaw.json');
}

export function getOpenClawMediaDir(...parts) {
  return join(getOpenClawDir(), 'media', ...parts);
}
