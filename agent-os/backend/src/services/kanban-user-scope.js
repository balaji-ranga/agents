import { listAgentsForUser } from './users.js';
import { resolveCeoDataUserId, getDefaultCeoUserId } from './job-applicant-ceo.js';

export function getKanbanScopeIds(authUserId) {
  const dataUserId = resolveCeoDataUserId(authUserId);
  return [...new Set([authUserId, dataUserId].filter(Boolean))];
}

function textHasScopedId(text, ids) {
  return ids.some((id) => text.includes(`ceo_user_id: ${id}`) || text.includes(`ceo_user_id:${id}`));
}

function textHasOwnerId(text, ids) {
  const match = text.match(/owner_user_id:\s*(\S+)/);
  if (!match) return false;
  return ids.includes(match[1]);
}

export function kanbanTaskBelongsToUser(task, authUser) {
  if (!authUser?.id || !task) return false;
  if (authUser.role === 'admin' && !authUser.impersonation) return false;

  const scopeIds = getKanbanScopeIds(authUser.id);
  const desc = String(task.description || '');
  const combined = `${desc}\n${task.delegation_prompt || ''}`;

  if (textHasOwnerId(combined, scopeIds)) return true;
  if (combined.includes('ceo_user_id') && textHasScopedId(combined, scopeIds)) return true;

  const isScopedPipeline =
    combined.includes('[job_pipeline:') ||
    combined.includes('[agent_workflow:') ||
    combined.includes('ceo_review_profile:') ||
    combined.includes('ceo_prefill_profile:') ||
    ['job_workflow', 'job_pipeline', 'agent_workflow', 'agent_workflow_ceo'].includes(task.created_by);

  if (isScopedPipeline) {
    if (!combined.includes('ceo_user_id') && !combined.includes('owner_user_id')) {
      return scopeIds.includes(getDefaultCeoUserId()) || scopeIds.includes('default');
    }
    return false;
  }

  if (task.assigned_agent_id) {
    const agents = listAgentsForUser(authUser.id);
    return agents.some((a) => a.id === task.assigned_agent_id);
  }

  return task.created_by === 'user';
}

export function filterKanbanTasksForUser(tasks, authUser) {
  return (tasks || []).filter((task) => kanbanTaskBelongsToUser(task, authUser));
}

export function assertKanbanTaskAccess(task, authUser) {
  if (!kanbanTaskBelongsToUser(task, authUser)) {
    const err = new Error('Task not found');
    err.status = 404;
    throw err;
  }
}
