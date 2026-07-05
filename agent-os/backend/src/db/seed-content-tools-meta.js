/**
 * Seed content_tools_meta with built-in tools if table is empty.
 * Called from initDb or on startup.
 */
import { getDb } from './schema.js';

const BUILTIN_TOOLS = [
  {
    name: 'summarize_url',
    display_name: 'Summarize URL',
    endpoint: '/api/tools/summarize-url',
    method: 'POST',
    purpose: 'Fetch a web page (HTTPS) and return a short summary and title. Use for research and citing sources.',
    model_used: 'gpt-4o-mini (optional, for summary)',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'generate_image',
    display_name: 'Generate Image',
    endpoint: '/api/tools/generate-image',
    method: 'POST',
    purpose: 'Generate an image from a text prompt. Use for social/draft assets (travel, food, nature).',
    model_used: 'gpt-image-1 (OpenAI)',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'generate_video',
    display_name: 'Generate Video',
    endpoint: '/api/tools/generate-video',
    method: 'POST',
    purpose: 'Generate a short video from a text prompt. Use for draft assets.',
    model_used: 'zeroscope-v2-xl (Replicate)',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'kanban_move_status',
    display_name: 'Kanban Move Status',
    endpoint: '/api/tools/kanban-move-status',
    method: 'POST',
    purpose: 'API tool: move a Kanban task status. Invoke this tool by name with parameters task_id (number) and new_status (open, awaiting_confirmation, in_progress, completed, failed). Do not run via exec or shell—call the tool directly. Use in_progress when starting, completed/failed when done.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'kanban_reassign_to_coo',
    display_name: 'Kanban Reassign to COO',
    endpoint: '/api/tools/kanban-reassign-to-coo',
    method: 'POST',
    purpose: 'API tool: reassign a task back to the COO. Invoke by name with parameter task_id. Do not run via exec or shell.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'kanban_assign_task',
    display_name: 'Kanban Assign Task',
    endpoint: '/api/tools/kanban-assign-task',
    method: 'POST',
    purpose: 'API tool (COO only): assign a Kanban task to an agent. Invoke by name with task_id and to_agent_id. Do not run via exec or shell.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'intent_classify_and_delegate',
    display_name: 'Intent Classify and Delegate',
    endpoint: '/api/tools/intent-classify-and-delegate',
    method: 'POST',
    purpose: 'API tool (COO only): classify message intent and delegate. Invoke by name with message and optional standup_id. Do not run via exec or shell.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'agent_workflow_list',
    display_name: 'List Agent Workflows',
    endpoint: '/api/tools/agent-workflow-list',
    method: 'POST',
    purpose:
      'API tool (COO only): list published custom agent workflows with chat trigger phrases for the CEO. Invoke by name with optional ceo_user_id. Use before agent_workflow_trigger to see available phrases.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'agent_workflow_trigger',
    display_name: 'Trigger Agent Workflow',
    endpoint: '/api/tools/agent-workflow-trigger',
    method: 'POST',
    purpose:
      'API tool (COO only): start a published custom agent workflow. Invoke with message containing the workflow chat phrase (e.g. "run brain approval test") OR workflow_id plus optional input. Parameters: message (required unless workflow_id), workflow_id (optional), ceo_user_id (optional). Do not run via exec or shell.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'agent_workflow_get_draft',
    display_name: 'Get Workflow Draft',
    endpoint: '/api/tools/agent-workflow-get-draft',
    method: 'POST',
    purpose:
      'API tool (Workflow Builder agent): get draft graph and metadata for a workflow. Parameters: workflow_id (required), optional ceo_user_id.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
  {
    name: 'agent_workflow_mutate',
    display_name: 'Mutate Workflow Draft',
    endpoint: '/api/tools/agent-workflow-mutate',
    method: 'POST',
    purpose:
      'API tool (Workflow Builder agent): add/update/delete workflow steps and edges. Parameters: workflow_id (optional for create_workflow action), actions (JSON array). Actions: create_workflow, add_node, update_node, delete_node, add_edge, set_metadata, publish, trigger_workflow. Do not run via exec.',
    model_used: '',
    enabled: 1,
    is_builtin: 1,
  },
];

const KANBAN_TOOLS = BUILTIN_TOOLS.filter((t) =>
  ['kanban_move_status', 'kanban_reassign_to_coo', 'kanban_assign_task', 'intent_classify_and_delegate'].includes(t.name)
);

const WORKFLOW_TOOLS = BUILTIN_TOOLS.filter((t) =>
  [
    'agent_workflow_list',
    'agent_workflow_trigger',
    'agent_workflow_get_draft',
    'agent_workflow_mutate',
  ].includes(t.name)
);

export function seedContentToolsMetaIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS n FROM content_tools_meta').get().n;
  if (count > 0) return;
  const stmt = db.prepare(
    `INSERT INTO content_tools_meta (name, display_name, endpoint, method, purpose, model_used, enabled, is_builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of BUILTIN_TOOLS) {
    stmt.run(t.name, t.display_name, t.endpoint, t.method, t.purpose, t.model_used, t.enabled, t.is_builtin);
  }
}

/** Add Kanban and intent tools if missing (for existing DBs). */
export function seedKanbanToolsIfMissing() {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO content_tools_meta (name, display_name, endpoint, method, purpose, model_used, enabled, is_builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of KANBAN_TOOLS) {
    stmt.run(t.name, t.display_name, t.endpoint, t.method, t.purpose, t.model_used, t.enabled, t.is_builtin);
  }
}

/** Add workflow chat tools if missing (for existing DBs). */
export function seedWorkflowToolsIfMissing() {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO content_tools_meta (name, display_name, endpoint, method, purpose, model_used, enabled, is_builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of WORKFLOW_TOOLS) {
    stmt.run(t.name, t.display_name, t.endpoint, t.method, t.purpose, t.model_used, t.enabled, t.is_builtin);
  }
  const update = db.prepare('UPDATE content_tools_meta SET purpose = ?, display_name = ? WHERE name = ?');
  for (const t of WORKFLOW_TOOLS) {
    update.run(t.purpose, t.display_name, t.name);
  }
}

/** Update purpose for Kanban/intent tools so they state "API tool" and "do not run via exec" (fixes agents using exec). */
export function updateKanbanToolPurposes() {
  const db = getDb();
  const update = db.prepare('UPDATE content_tools_meta SET purpose = ? WHERE name = ?');
  for (const t of KANBAN_TOOLS) {
    update.run(t.purpose, t.name);
  }
}
