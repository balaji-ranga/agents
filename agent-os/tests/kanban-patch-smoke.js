/**
 * Smoke test for Kanban PATCH endpoint (used by drag-and-drop UI).
 * Run: node tests/kanban-patch-smoke.js 38 in_progress
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const id = Number(process.argv[2] || 0);
const toStatus = process.argv[3] || 'in_progress';
if (!id) {
  console.error('Usage: node tests/kanban-patch-smoke.js <taskId> [status]');
  process.exit(1);
}

async function run() {
  const patch = await fetch(`${BASE}/api/kanban/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: toStatus }),
  });
  const patchJson = await patch.json().catch(() => ({}));
  console.log('PATCH status', patch.status, patchJson);
  if (!patch.ok) process.exit(2);

  const get = await fetch(`${BASE}/api/kanban/tasks/${id}`);
  const getJson = await get.json().catch(() => ({}));
  console.log('GET status', get.status, { id: getJson.id, status: getJson.status });
  if (!get.ok) process.exit(3);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

