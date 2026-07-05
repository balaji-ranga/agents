/**
 * Content tools metadata: read/write DB and write OpenClaw tools list file for the plugin.
 */
import { getDb } from '../db/schema.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const USERPROFILE = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_DIR = join(USERPROFILE, '.openclaw');
const DEFAULT_TOOLS_LIST_PATH = join(OPENCLAW_DIR, 'agent-os-tools.json');

export function getToolsListPath() {
  return process.env.OPENCLAW_TOOLS_LIST_PATH || DEFAULT_TOOLS_LIST_PATH;
}

export function listToolsMeta() {
  const db = getDb();
  return db.prepare('SELECT name, display_name, endpoint, method, purpose, model_used, enabled, is_builtin, created_at FROM content_tools_meta ORDER BY is_builtin DESC, name').all();
}

export function getToolMeta(name) {
  const db = getDb();
  return db.prepare('SELECT name, display_name, endpoint, method, purpose, model_used, enabled, is_builtin, created_at, auth_header FROM content_tools_meta WHERE name = ?').get(name);
}

export function updateToolMeta(name, patch) {
  const db = getDb();
  const allowed = ['display_name', 'endpoint', 'method', 'purpose', 'model_used', 'enabled', 'auth_header'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      if (key === 'enabled') {
        updates.push('enabled = ?');
        values.push(patch[key] ? 1 : 0);
      } else {
        updates.push(`${key} = ?`);
        values.push(patch[key]);
      }
    }
  }
  if (updates.length === 0) return getToolMeta(name);
  values.push(name);
  db.prepare(`UPDATE content_tools_meta SET ${updates.join(', ')} WHERE name = ?`).run(...values);
  writeOpenClawToolsList();
  return getToolMeta(name);
}

export function createToolMeta(record) {
  const db = getDb();
  const { name, display_name, endpoint, method = 'POST', purpose = '', model_used = '', auth_header = '' } = record;
  if (!name || !display_name || !endpoint) throw new Error('name, display_name, and endpoint are required');
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '_');
  const auth = (auth_header || '').trim();
  db.prepare(
    `INSERT INTO content_tools_meta (name, display_name, endpoint, method, purpose, model_used, enabled, is_builtin, auth_header) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`
  ).run(normalized, display_name.trim(), endpoint.trim(), method, purpose.trim(), (model_used || '').trim(), auth || null);
  writeOpenClawToolsList();
  return getToolMeta(normalized);
}

/**
 * Write enabled tools to a JSON file for the OpenClaw plugin to read.
 */
export function writeOpenClawToolsList() {
  const db = getDb();
  const rows = db.prepare('SELECT name, display_name, endpoint, method, purpose FROM content_tools_meta WHERE enabled = 1 ORDER BY is_builtin DESC, name').all();
  const path = getToolsListPath();
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(rows, null, 2), 'utf8');
}
