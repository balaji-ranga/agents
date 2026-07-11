import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const dbPath = join(dirname(fileURLToPath(import.meta.url)), '../data/agent-os.db');
const db = new Database(dbPath, { readonly: true });

const workflows = db
  .prepare(
    `SELECT id, name, status, published_graph_json FROM agent_workflow_definitions
     WHERE name LIKE '%Custom Script E2E%' ORDER BY id DESC LIMIT 5`
  )
  .all();

for (const w of workflows) {
  const graph = JSON.parse(w.published_graph_json || '{}');
  console.log('\nWorkflow:', w.id, w.name, w.status);
  console.log(
    'Nodes:',
    (graph.nodes || []).map((n) => ({
      id: n.id,
      type: n.type,
      config: n.data?.taskConfig || n.data?.config,
      bindings: n.data?.inputBindings,
    }))
  );
}

const runs = db
  .prepare(
    `SELECT r.id, r.status, r.progress_pct, r.run_number, d.name, r.context_json
     FROM agent_workflow_runs r
     JOIN agent_workflow_definitions d ON d.id = r.definition_id
     WHERE d.name LIKE '%Custom Script E2E%'
     ORDER BY r.id DESC LIMIT 5`
  )
  .all();

console.log('\nRuns:', runs);

for (const r of runs) {
  const steps = db
    .prepare(
      `SELECT node_id, node_type, status, error_message FROM agent_workflow_run_steps WHERE run_id = ?`
    )
    .all(r.id);
  console.log(`\nRun #${r.run_number} (${r.id}) status=${r.status} progress=${r.progress_pct}%`);
  console.log('Steps:', steps);
}
