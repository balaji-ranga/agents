/**
 * Per-CEO tenant SQLite database (job profiles, jobs, kanban, chat, standups).
 */
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const _ceoDbs = new Map();

function getTenantsRoot() {
  const dataDir = process.env.AGENT_OS_DATA_DIR || join(__dirname, '../../data');
  return join(dataDir, 'tenants');
}

export function getCeoDbPath(ceoUserId) {
  const safe = String(ceoUserId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const dir = join(getTenantsRoot(), safe);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'ceo.db');
}

function runCeoSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_search_profiles (
      id TEXT NOT NULL,
      ceo_user_id TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      intake_json TEXT DEFAULT '{}',
      version INTEGER DEFAULT 1,
      confirmed_at TEXT,
      last_pipeline_run_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ceo_user_id, id)
    );

    CREATE TABLE IF NOT EXISTS job_search_ceo_settings (
      ceo_user_id TEXT PRIMARY KEY,
      active_profile_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_applications (
      job_id TEXT PRIMARY KEY,
      profile_id TEXT,
      ceo_user_id TEXT,
      status TEXT DEFAULT 'discovered',
      source TEXT,
      company TEXT,
      title TEXT,
      location TEXT,
      url TEXT,
      fit_score REAL,
      fit_rationale TEXT,
      why_me_summary TEXT,
      cover_letter_text TEXT,
      tailoring_notes TEXT,
      owner_action TEXT,
      application_notes TEXT,
      extra_json TEXT,
      discovered_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_applications_status ON job_applications(status);
    CREATE INDEX IF NOT EXISTS idx_job_applications_profile ON job_applications(profile_id);

    CREATE TABLE IF NOT EXISTS job_pipeline_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      standup_id INTEGER,
      enabled INTEGER DEFAULT 0,
      ceo_user_id TEXT,
      active_profile_id TEXT,
      last_discovery_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO job_pipeline_state (id, enabled) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS job_workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_number INTEGER NOT NULL,
      ceo_user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      workflow_goal TEXT DEFAULT 'job_application',
      status TEXT DEFAULT 'running',
      trigger TEXT DEFAULT 'manual',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      kanban_ceo_review_task_id INTEGER,
      metadata_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_workflow_runs_profile ON job_workflow_runs(ceo_user_id, profile_id);

    CREATE TABLE IF NOT EXISTS job_workflow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_run_id INTEGER NOT NULL,
      step_key TEXT NOT NULL,
      step_label TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      actor_type TEXT,
      actor_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      detail_json TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workflow_run_id) REFERENCES job_workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_workflow_steps_run ON job_workflow_steps(workflow_run_id);

    CREATE TABLE IF NOT EXISTS kanban_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      assigned_agent_id TEXT,
      created_by TEXT DEFAULT 'user',
      standup_id INTEGER,
      agent_delegation_task_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      due_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status);

    CREATE TABLE IF NOT EXISTS task_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES kanban_tasks(id)
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_turns_agent ON chat_turns(agent_id);

    CREATE TABLE IF NOT EXISTS standups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_at TEXT NOT NULL,
      status TEXT DEFAULT 'scheduled',
      coo_summary TEXT,
      ceo_summary TEXT,
      source TEXT DEFAULT 'manual',
      title TEXT,
      outcomes TEXT,
      approved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS standup_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standup_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (standup_id) REFERENCES standups(id)
    );

    CREATE TABLE IF NOT EXISTS standup_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standup_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      submitted_at TEXT DEFAULT (datetime('now')),
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
      FOREIGN KEY (standup_id) REFERENCES standups(id)
    );

    CREATE TABLE IF NOT EXISTS content_tool_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      source TEXT,
      request_payload TEXT,
      response_payload TEXT,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function initCeoDb(ceoUserId) {
  const key = String(ceoUserId);
  if (_ceoDbs.has(key)) return _ceoDbs.get(key);
  const db = new Database(getCeoDbPath(key));
  db.pragma('journal_mode = WAL');
  runCeoSchema(db);
  try {
    db.exec(`ALTER TABLE job_pipeline_state ADD COLUMN active_workflow_run_id INTEGER`);
  } catch (_) {}
  db.prepare(`UPDATE job_pipeline_state SET ceo_user_id = ? WHERE id = 1`).run(key);
  _ceoDbs.set(key, db);
  return db;
}

export function getCeoDb(ceoUserId) {
  const key = String(ceoUserId || '').trim();
  if (!key) throw new Error('ceo_user_id required');
  return initCeoDb(key);
}

export function closeCeoDb(ceoUserId) {
  const key = String(ceoUserId);
  const db = _ceoDbs.get(key);
  if (db) {
    try {
      db.close();
    } catch (_) {}
    _ceoDbs.delete(key);
  }
}
