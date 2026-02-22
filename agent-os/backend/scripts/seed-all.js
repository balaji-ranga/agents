/**
 * Seed Agent OS DB: BalServe (COO), TechResearcher, and one sample standup.
 * Run from backend: node scripts/seed-all.js
 * Prereq: openclaw gateway running if you want chat to use per-agent workspaces.
 */
import { join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

process.chdir(join(__dirname, '..'));
const { initDb, getDb } = await import('../src/db/schema.js');
initDb();
await import('./seed-balserve.js');
await import('./seed-techresearcher.js');

const db = getDb();
const count = db.prepare('SELECT COUNT(*) as n FROM standups').get();
if (count.n === 0) {
  const at = new Date().toISOString();
  db.prepare('INSERT INTO standups (scheduled_at, status, coo_summary, ceo_summary) VALUES (?, ?, ?, ?)').run(
    at,
    'completed',
    'TechResearcher reported: 3 LinkedIn topics (2 AI, 1 robotics) proposed; CEO approved one. BalServe aggregated blockers: none.',
    'Daily digest: One LinkedIn post approved for today. Research focus on AI and robotics. No blockers.'
  );
  console.log('Seeded one sample standup.');
}
console.log('Seed-all done.');
