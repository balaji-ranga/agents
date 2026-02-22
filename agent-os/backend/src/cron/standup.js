/**
 * Standup cron: create standup, collect status from agents (COO → agents via OpenClaw), run COO summarization.
 * Call runScheduledStandup() from node-cron or POST /cron/run-standup.
 */

import { getDb } from '../db/schema.js';
import * as openclaw from '../gateway/openclaw.js';
import { runCooSummarization } from '../services/coo.js';

const STANDUP_PROMPT =
  "The COO is collecting today's standup. What is your status and a brief summary? Reply in 2–4 sentences: what you did, any blockers, and next steps.";

function db() {
  return getDb();
}

/**
 * Run the full standup flow: create standup, collect from each delegated agent via OpenClaw, then run COO.
 * @returns {{ standup: object, error?: string }}
 */
export async function runScheduledStandup() {
  const coo = db().prepare('SELECT * FROM agents WHERE is_coo = 1 LIMIT 1').get();
  if (!coo) {
    return { standup: null, error: 'No COO agent configured' };
  }

  const delegated = db()
    .prepare('SELECT * FROM agents WHERE parent_id = ? AND id != ?')
    .all(coo.id, coo.id);

  const now = new Date().toISOString();
  db().prepare('INSERT INTO standups (scheduled_at, status, source) VALUES (?, ?, ?)').run(now, 'scheduled', 'cron');
  const standup = db().prepare('SELECT * FROM standups ORDER BY id DESC LIMIT 1').get();
  if (!standup) return { standup: null, error: 'Failed to create standup' };

  const sessionUser = openclaw.sessionUserFor('cron', 'standup-collect');

  for (const agent of delegated) {
    const openclawId = agent.openclaw_agent_id || 'main';
    try {
      const { content } = await openclaw.chatCompletions(
        openclawId,
        [{ role: 'user', content: STANDUP_PROMPT }],
        sessionUser,
        false
      );
      db()
        .prepare('INSERT INTO standup_responses (standup_id, agent_id, content) VALUES (?, ?, ?)')
        .run(standup.id, agent.id, content || '(no response)');
    } catch (err) {
      db()
        .prepare('INSERT INTO standup_responses (standup_id, agent_id, content) VALUES (?, ?, ?)')
        .run(standup.id, agent.id, `[Error collecting: ${err.message}]`);
    }
  }

  const responses = db()
    .prepare('SELECT agent_id, content FROM standup_responses WHERE standup_id = ? ORDER BY submitted_at')
    .all(standup.id);

  try {
    const { coo_summary, ceo_summary } = await runCooSummarization(responses, []);
    db()
      .prepare('UPDATE standups SET coo_summary = ?, ceo_summary = ?, status = ? WHERE id = ?')
      .run(coo_summary, ceo_summary, 'completed', standup.id);
  } catch (err) {
    db()
      .prepare('UPDATE standups SET status = ? WHERE id = ?')
      .run('coo_failed', standup.id);
    return { standup: db().prepare('SELECT * FROM standups WHERE id = ?').get(standup.id), error: err.message };
  }

  return { standup: db().prepare('SELECT * FROM standups WHERE id = ?').get(standup.id) };
}
