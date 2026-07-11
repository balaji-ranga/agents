import { getDb } from '../db/schema.js';
import { listAgentsForUser } from './users.js';
import { resolveCeoDataUserId } from './job-applicant-ceo.js';

function db() {
  return getDb();
}

function promptBelongsToCeo(prompt, authUserId) {
  const text = String(prompt || '');
  if (!text.includes('ceo_user_id')) return true;
  const dataUserId = resolveCeoDataUserId(authUserId);
  const ids = [...new Set([authUserId, dataUserId].filter(Boolean))];
  return ids.some(
    (id) => text.includes(`ceo_user_id: ${id}`) || text.includes(`ceo_user_id:${id}`)
  );
}

function isJobPipelineRow(row) {
  return row.standup_source === 'job_pipeline' || String(row.prompt || '').includes('[job_pipeline:');
}

export function listAgentResponseNotificationsForUser(authUser, { limit = 20 } = {}) {
  if (!authUser?.id) return [];
  if (authUser.role === 'admin') return [];

  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const agents = listAgentsForUser(authUser.id);
  const agentIds = agents.map((a) => a.id);
  if (!agentIds.length) return [];

  const placeholders = agentIds.map(() => '?').join(',');
  const rows = db()
    .prepare(
      `SELECT t.id, t.standup_id, t.to_agent_id, t.prompt, t.response_content, t.completed_at, t.request_id,
              s.scheduled_at, s.title, s.source AS standup_source,
              a.name AS agent_name,
              k.id AS kanban_task_id
       FROM agent_delegation_tasks t
       JOIN standups s ON s.id = t.standup_id
       LEFT JOIN agents a ON a.id = t.to_agent_id
       LEFT JOIN kanban_tasks k ON k.agent_delegation_task_id = t.id
       WHERE t.status = 'completed'
         AND t.response_content IS NOT NULL
         AND t.response_content != ''
         AND t.to_agent_id IN (${placeholders})
       ORDER BY t.completed_at DESC
       LIMIT ?`
    )
    .all(...agentIds, cap * 4);

  return rows
    .filter((r) => !isJobPipelineRow(r) || promptBelongsToCeo(r.prompt, authUser.id))
    .slice(0, cap)
    .map((r) => ({
      id: r.id,
      kind: 'agent',
      standup_id: r.standup_id,
      to_agent_id: r.to_agent_id,
      agent_name: r.agent_name || r.to_agent_id,
      completed_at: r.completed_at,
      scheduled_at: r.scheduled_at,
      standup_title: r.title,
      standup_source: r.standup_source,
      kanban_task_id: r.kanban_task_id,
      is_job_pipeline: isJobPipelineRow(r),
      prompt_snippet: (r.prompt || '').trim().slice(0, 120),
      response_snippet: (r.response_content || '').trim().slice(0, 150),
    }));
}
