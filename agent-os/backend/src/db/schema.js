import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDbPath() {
  const dataDir = process.env.AGENT_OS_DATA_DIR || join(__dirname, '../../data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return join(dataDir, 'agent-os.db');
}

let _db = null;

export function initDb() {
  if (_db) return _db;
  _db = new Database(getDbPath());
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT DEFAULT '',
      parent_id TEXT,
      workspace_path TEXT,
      openclaw_agent_id TEXT DEFAULT 'main',
      is_coo INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS workspace_files (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      last_modified TEXT
    );

    CREATE TABLE IF NOT EXISTS standups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_at TEXT NOT NULL,
      status TEXT DEFAULT 'scheduled',
      coo_summary TEXT,
      ceo_summary TEXT,
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS standup_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standup_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      submitted_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (standup_id) REFERENCES standups(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_turns_agent ON chat_turns(agent_id);
    CREATE TABLE IF NOT EXISTS standup_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standup_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (standup_id) REFERENCES standups(id)
    );

    CREATE TABLE IF NOT EXISTS agent_delegation_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standup_id INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      response_content TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (standup_id) REFERENCES standups(id),
      FOREIGN KEY (to_agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_standup_responses_standup ON standup_responses(standup_id);
    CREATE INDEX IF NOT EXISTS idx_standup_messages_standup ON standup_messages(standup_id);
    CREATE TABLE IF NOT EXISTS delegation_callbacks (
      request_id TEXT PRIMARY KEY,
      posted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_delegation_tasks_status ON agent_delegation_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_delegation_tasks_request ON agent_delegation_tasks(request_id);
  `);

  try {
    _db.exec(`ALTER TABLE standups ADD COLUMN source TEXT DEFAULT 'manual'`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE standups ADD COLUMN approved_at TEXT`);
  } catch (_) {}
  try {
    _db.exec(`CREATE TABLE standup_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, standup_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (standup_id) REFERENCES standups(id))`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_standup_messages_standup ON standup_messages(standup_id)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE TABLE agent_delegation_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, standup_id INTEGER NOT NULL, request_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT DEFAULT 'pending', response_content TEXT, error_message TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT, FOREIGN KEY (standup_id) REFERENCES standups(id), FOREIGN KEY (to_agent_id) REFERENCES agents(id))`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_delegation_tasks_status ON agent_delegation_tasks(status)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_delegation_tasks_request ON agent_delegation_tasks(request_id)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE TABLE delegation_callbacks (request_id TEXT PRIMARY KEY, posted_at TEXT DEFAULT (datetime('now')))`);
  } catch (_) {}

  return _db;
}

export function getDb() {
  if (!_db) initDb();
  return _db;
}

export { getDbPath };
