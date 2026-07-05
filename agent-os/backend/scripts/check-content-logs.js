/**
 * Quick script to read content_tool_logs from agent-os DB.
 * Run from backend: node scripts/check-content-logs.js
 */
import Database from 'better-sqlite3';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.AGENT_OS_DATA_DIR || join(__dirname, '../data');
const dbPath = join(dataDir, 'agent-os.db');

const db = new Database(dbPath, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map((t) => t.name).join(', '));
try {
  const rows = db.prepare(
    'SELECT id, tool_name, source, status, created_at FROM content_tool_logs ORDER BY created_at DESC LIMIT 20'
  ).all();
  console.log('content_tool_logs (recent):', JSON.stringify(rows, null, 2));
} catch (e) {
  console.log('content_tool_logs error:', e.message);
}
db.close();
