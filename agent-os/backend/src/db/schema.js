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

    CREATE TABLE IF NOT EXISTS content_tool_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      source TEXT,
      request_payload TEXT,
      response_payload TEXT,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_content_tool_logs_created ON content_tool_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_tool_logs_tool ON content_tool_logs(tool_name);

    CREATE TABLE IF NOT EXISTS content_tools_meta (
      name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT DEFAULT 'POST',
      purpose TEXT DEFAULT '',
      model_used TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      is_builtin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      auth_header TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_content_tools_meta_enabled ON content_tools_meta(enabled);

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
      due_date TEXT,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id),
      FOREIGN KEY (standup_id) REFERENCES standups(id),
      FOREIGN KEY (agent_delegation_task_id) REFERENCES agent_delegation_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_assigned ON kanban_tasks(assigned_agent_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_tasks_created ON kanban_tasks(created_at);

    CREATE TABLE IF NOT EXISTS task_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES kanban_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id);
  `);

  try {
    _db.exec(`ALTER TABLE standups ADD COLUMN source TEXT DEFAULT 'manual'`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE standups ADD COLUMN approved_at TEXT`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE standups ADD COLUMN title TEXT`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE standups ADD COLUMN outcomes TEXT`);
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
  try {
    _db.exec(`CREATE TABLE content_tool_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, source TEXT, request_payload TEXT, response_payload TEXT, status TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_content_tool_logs_created ON content_tool_logs(created_at DESC)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_content_tool_logs_tool ON content_tool_logs(tool_name)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE TABLE content_tools_meta (name TEXT PRIMARY KEY, display_name TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT DEFAULT 'POST', purpose TEXT DEFAULT '', model_used TEXT DEFAULT '', enabled INTEGER DEFAULT 1, is_builtin INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), auth_header TEXT DEFAULT '')`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_content_tools_meta_enabled ON content_tools_meta(enabled)`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE content_tools_meta ADD COLUMN auth_header TEXT DEFAULT ''`);
  } catch (_) {}
  try {
    _db.exec(`CREATE TABLE kanban_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'open', assigned_agent_id TEXT, created_by TEXT DEFAULT 'user', standup_id INTEGER, agent_delegation_task_id INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), due_date TEXT, FOREIGN KEY (assigned_agent_id) REFERENCES agents(id), FOREIGN KEY (standup_id) REFERENCES standups(id), FOREIGN KEY (agent_delegation_task_id) REFERENCES agent_delegation_tasks(id))`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_tasks_assigned ON kanban_tasks(assigned_agent_id)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_tasks_created ON kanban_tasks(created_at)`);
  } catch (_) {}
  try {
    _db.exec(`CREATE TABLE task_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (task_id) REFERENCES kanban_tasks(id))`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id)`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS job_search_profiles (
        id TEXT NOT NULL,
        ceo_user_id TEXT NOT NULL DEFAULT 'default',
        display_name TEXT DEFAULT '',
        status TEXT DEFAULT 'draft',
        intake_json TEXT DEFAULT '{}',
        version INTEGER DEFAULT 1,
        confirmed_at TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (ceo_user_id, id)
      )
    `);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_search_profiles ADD COLUMN ceo_user_id TEXT DEFAULT 'default'`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_search_profiles ADD COLUMN display_name TEXT DEFAULT ''`);
  } catch (_) {}
  try {
    _db.exec(`UPDATE job_search_profiles SET ceo_user_id = 'default' WHERE ceo_user_id IS NULL OR ceo_user_id = ''`);
  } catch (_) {}
  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS job_search_ceo_settings (
        ceo_user_id TEXT PRIMARY KEY,
        active_profile_id TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_applications ADD COLUMN profile_id TEXT`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_applications ADD COLUMN ceo_user_id TEXT DEFAULT 'default'`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_pipeline_state ADD COLUMN ceo_user_id TEXT DEFAULT 'default'`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_pipeline_state ADD COLUMN active_profile_id TEXT`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_pipeline_state ADD COLUMN active_workflow_run_id INTEGER`);
  } catch (_) {}
  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS job_applications (
        job_id TEXT PRIMARY KEY,
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
      )
    `);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_applications_status ON job_applications(status)`);
  } catch (_) {}
  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS job_pipeline_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        standup_id INTEGER,
        enabled INTEGER DEFAULT 0,
        last_discovery_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE job_search_profiles ADD COLUMN last_pipeline_run_at TEXT`);
  } catch (_) {}
  try {
    _db.exec(`INSERT OR IGNORE INTO job_pipeline_state (id, enabled) VALUES (1, 0)`);
  } catch (_) {}
  try {
    _db.exec(`
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
      )
    `);
    _db.exec(`
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
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_workflow_runs_profile ON job_workflow_runs(ceo_user_id, profile_id)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_job_workflow_steps_run ON job_workflow_steps(workflow_run_id)`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS platform_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        region TEXT DEFAULT '',
        mobile TEXT DEFAULT '',
        role TEXT NOT NULL CHECK (role IN ('admin', 'ceo')),
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS platform_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES platform_users(id)
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS user_agents (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        granted_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, agent_id),
        FOREIGN KEY (user_id) REFERENCES platform_users(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_platform_users_email ON platform_users(email)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents(user_id)`);
  } catch (_) {}

  try {
    _db.exec(`ALTER TABLE platform_users ADD COLUMN ceo_db_mode TEXT DEFAULT 'tenant'`);
  } catch (_) {}
  try {
    const balaId = (process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala').trim();
    _db.prepare(`UPDATE platform_users SET ceo_db_mode = 'shared' WHERE id = ?`).run(balaId);
    _db.prepare(`UPDATE platform_users SET ceo_db_mode = 'shared' WHERE id = 'default'`);
  } catch (_) {}

  try {
    _db.exec(`ALTER TABLE agents ADD COLUMN agent_type TEXT DEFAULT 'standard'`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE agents ADD COLUMN owner_user_id TEXT`);
  } catch (_) {}
  try {
    _db.exec(`UPDATE agents SET agent_type = 'standard' WHERE agent_type IS NULL OR agent_type = ''`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_user_id TEXT NOT NULL,
        status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
        draft_graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
        published_graph_json TEXT,
        schedule_cron TEXT,
        chat_trigger_phrase TEXT,
        trigger_modes TEXT DEFAULT 'manual',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        definition_id TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT DEFAULT '',
        changed_by TEXT,
        changed_by_name TEXT,
        diff_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (definition_id) REFERENCES agent_workflow_definitions(id)
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_number INTEGER NOT NULL,
        definition_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        status TEXT DEFAULT 'running',
        trigger TEXT DEFAULT 'manual',
        progress_pct INTEGER DEFAULT 0,
        context_json TEXT DEFAULT '{}',
        standup_id INTEGER,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        error_message TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (definition_id) REFERENCES agent_workflow_definitions(id)
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_run_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        node_label TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        input_json TEXT,
        output_json TEXT,
        delegation_task_id INTEGER,
        kanban_task_id INTEGER,
        started_at TEXT,
        completed_at TEXT,
        error_message TEXT,
        FOREIGN KEY (run_id) REFERENCES agent_workflow_runs(id)
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_wf_defs_owner ON agent_workflow_definitions(owner_user_id)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_wf_audit_def ON agent_workflow_audit(definition_id, created_at DESC)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_wf_runs_def ON agent_workflow_runs(definition_id, started_at DESC)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_wf_steps_run ON agent_workflow_run_steps(run_id)`);
  } catch (_) {}

  try {
    _db.exec(`ALTER TABLE agent_workflow_definitions ADD COLUMN paused INTEGER DEFAULT 0`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE agent_workflow_definitions ADD COLUMN webhook_secret TEXT`);
  } catch (_) {}
  try {
    _db.exec(`ALTER TABLE agent_workflow_run_steps ADD COLUMN iteration INTEGER DEFAULT 1`);
  } catch (_) {}
  try {
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_wf_steps_run_node_iter ON agent_workflow_run_steps(run_id, node_id, iteration)`);
  } catch (_) {}
  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_pending_listeners (
        run_id INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        mcp_server_id TEXT,
        events_path TEXT DEFAULT '/events/stream',
        timeout_ms INTEGER DEFAULT 30000,
        started_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, node_id),
        FOREIGN KEY (run_id) REFERENCES agent_workflow_runs(id) ON DELETE CASCADE
      )
    `);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_schedule_ticks (
        definition_id TEXT NOT NULL,
        tick_minute TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (definition_id, tick_minute)
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_schedules (
        definition_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        workflow_name TEXT DEFAULT '',
        schedule_cron TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (definition_id) REFERENCES agent_workflow_definitions(id) ON DELETE CASCADE
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_wf_schedules_enabled ON agent_workflow_schedules(enabled)`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_chat_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    _db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_wf_chat_thread ON agent_workflow_chat_turns(owner_user_id, workflow_id, created_at)`
    );
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        transport TEXT NOT NULL DEFAULT 'streamable_http',
        url TEXT,
        command TEXT,
        args_json TEXT DEFAULT '[]',
        cwd TEXT,
        env_json TEXT DEFAULT '{}',
        headers_json TEXT DEFAULT '{}',
        auth_secret_env TEXT DEFAULT '',
        owner_user_id TEXT NOT NULL,
        owner_role TEXT NOT NULL CHECK (owner_role IN ('admin', 'ceo')),
        is_platform INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'healthy', 'disabled')),
        last_health_at TEXT,
        last_error TEXT,
        server_info_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tools_cache (
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        description TEXT DEFAULT '',
        input_schema_json TEXT,
        PRIMARY KEY (server_id, tool_name),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_prompts_cache (
        server_id TEXT NOT NULL,
        prompt_name TEXT NOT NULL,
        description TEXT DEFAULT '',
        arguments_schema_json TEXT,
        PRIMARY KEY (server_id, prompt_name),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_resources_cache (
        server_id TEXT NOT NULL,
        resource_uri TEXT NOT NULL,
        name TEXT DEFAULT '',
        description TEXT DEFAULT '',
        mime_type TEXT DEFAULT '',
        PRIMARY KEY (server_id, resource_uri),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      )
    `);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        tool_name TEXT,
        user_id TEXT,
        request_json TEXT,
        response_json TEXT,
        status TEXT,
        latency_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers(owner_user_id)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_servers_platform ON mcp_servers(is_platform)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_server ON mcp_call_logs(server_id, created_at DESC)`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tool_grants (
        agent_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, tool_name),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tool_grants_agent ON agent_tool_grants(agent_id)`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS external_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        card_url TEXT,
        endpoint_url TEXT,
        skill_id TEXT,
        auth_header TEXT,
        headers_json TEXT DEFAULT '{}',
        agent_card_json TEXT,
        owner_user_id TEXT NOT NULL,
        owner_role TEXT NOT NULL CHECK (owner_role IN ('admin', 'ceo')),
        is_platform INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'healthy', 'disabled')),
        last_health_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_external_agents_owner ON external_agents(owner_user_id)`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS custom_scripts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        language TEXT NOT NULL DEFAULT 'python' CHECK (language IN ('python', 'javascript')),
        runtime_profile TEXT NOT NULL DEFAULT 'restricted' CHECK (runtime_profile IN ('restricted', 'network')),
        source TEXT NOT NULL,
        scan_result_json TEXT,
        scan_status TEXT DEFAULT 'pending' CHECK (scan_status IN ('pending', 'approved', 'rejected')),
        risk_level TEXT DEFAULT 'low',
        owner_user_id TEXT NOT NULL,
        owner_role TEXT NOT NULL CHECK (owner_role IN ('admin', 'ceo')),
        is_platform INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'disabled')),
        last_run_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_scripts_owner ON custom_scripts(owner_user_id)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_scripts_status ON custom_scripts(status, scan_status)`);
  } catch (_) {}

  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS platform_user_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT DEFAULT '',
        link_url TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES platform_users(id)
      )
    `);
    _db.exec(
      `CREATE INDEX IF NOT EXISTS idx_platform_user_notifications_user ON platform_user_notifications(user_id, created_at DESC)`
    );
  } catch (_) {}

  try {
    _db.exec(`ALTER TABLE platform_sessions ADD COLUMN impersonator_user_id TEXT`);
  } catch (_) {}

  try {
    _db.exec(`ALTER TABLE chat_turns ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'default'`);
  } catch (_) {}
  try {
    _db.exec(
      `CREATE INDEX IF NOT EXISTS idx_chat_turns_agent_owner ON chat_turns(agent_id, owner_user_id)`
    );
  } catch (_) {}
  try {
    const legacyOwner = (process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala').trim() || 'ceo-bala';
    _db.prepare(`UPDATE chat_turns SET owner_user_id = ? WHERE owner_user_id = 'default'`).run(legacyOwner);
  } catch (_) {}

  try {
    _db.exec(`ALTER TABLE content_tool_logs ADD COLUMN owner_user_id TEXT`);
  } catch (_) {}
  try {
    _db.exec(
      `CREATE INDEX IF NOT EXISTS idx_content_tool_logs_owner ON content_tool_logs(owner_user_id, created_at DESC)`
    );
  } catch (_) {}
  try {
    const legacyOwner = (process.env.AGENT_OS_BALA_CEO_ID || 'ceo-bala').trim() || 'ceo-bala';
    _db.prepare(`UPDATE content_tool_logs SET owner_user_id = ? WHERE owner_user_id IS NULL`).run(legacyOwner);
  } catch (_) {}

  return _db;
}

export function getDb() {
  if (!_db) initDb();
  return _db;
}

export { getDbPath };
