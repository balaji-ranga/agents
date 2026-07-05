import { initDb, getDb } from '../src/db/schema.js';
import { resolveKanbanTaskArtifacts } from '../src/services/kanban-artifacts.js';

initDb();
const db = getDb();
const task = db
  .prepare(`SELECT * FROM kanban_tasks WHERE description LIKE 'ceo_review_profile:%' ORDER BY id DESC LIMIT 1`)
  .get();
if (!task) {
  console.log('No CEO review task found');
  process.exit(0);
}
const messages = db.prepare('SELECT id, role, content FROM task_messages WHERE task_id = ?').all(task.id);
const result = resolveKanbanTaskArtifacts(task, null, messages);
console.log(`Task #${task.id}: ${result.count} artifacts`);
console.log('Groups:', result.groups.slice(0, 5));
console.log(
  'Sample:',
  result.artifacts.slice(0, 4).map((a) => ({ kind: a.kind, label: a.label, group: a.group, inline: a.inline }))
);
const pdfs = result.artifacts.filter((a) => a.kind === 'pdf');
console.log(`PDFs: ${pdfs.length}`);
if (pdfs.length === 0) process.exit(1);
