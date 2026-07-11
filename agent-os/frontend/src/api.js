const API_BASE = import.meta.env.VITE_API_URL || '/api';

let _authToken = null;

export function setAuthToken(token) {
  _authToken = token || null;
}

async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (_authToken) headers.Authorization = `Bearer ${_authToken}`;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function get(path) {
  return request(path, { method: 'GET' });
}

async function post(path, body) {
  return request(path, { method: 'POST', body: JSON.stringify(body) });
}

async function put(path, body) {
  return request(path, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function patch(path, body) {
  return request(path, { method: 'PATCH', body: JSON.stringify(body) });
}

async function del(path) {
  return request(path, { method: 'DELETE' });
}

/** Fetch authenticated binary (PDF, image) and return a blob object URL. Caller should revoke when done. */
async function fetchBlobUrl(path) {
  const url = path.startsWith('http')
    ? path
    : path.startsWith('/api/')
      ? path
      : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {};
  if (_authToken) headers.Authorization = `Bearer ${_authToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export const api = {
  fetchBlobUrl,
  health: () => get('/health'),
  // Workspace (OpenClaw MD files) — legacy single-workspace (optional)
  workspaceFiles: () => get('/workspace/files'),
  workspaceRead: (name) => get(`/workspace/files/${encodeURIComponent(name)}`),
  workspaceWrite: (name, text) => put(`/workspace/files/${encodeURIComponent(name)}`, { text }),
  // Per-agent workspace (MD files)
  agentWorkspaceFiles: (agentId) => get(`/agents/${encodeURIComponent(agentId)}/workspace/files`),
  agentWorkspaceRead: (agentId, name) => get(`/agents/${encodeURIComponent(agentId)}/workspace/files/${encodeURIComponent(name)}`),
  agentWorkspaceWrite: (agentId, name, text) => put(`/agents/${encodeURIComponent(agentId)}/workspace/files/${encodeURIComponent(name)}`, { text }),
  agentToolsGet: (agentId) => get(`/agents/${encodeURIComponent(agentId)}/tools`),
  agentToolsSet: (agentId, tools, opts = {}) =>
    put(`/agents/${encodeURIComponent(agentId)}/tools`, { tools, ...opts }),
  agentToolsSyncTemplateMd: (agentId, templateId) =>
    post(`/agents/${encodeURIComponent(agentId)}/tools/sync-template-md`, templateId ? { template_id: templateId } : {}),
  // Agents
  agentsList: () => get('/agents'),
  agentGet: (id) => get(`/agents/${id}`),
  agentCreate: (body) => post('/agents', body),
  agentUpdate: (id, body) => patch(`/agents/${id}`, body),
  agentDelete: (id) => del(`/agents/${id}`),
  agentChatHistory: (id) => get(`/agents/${id}/chat`),
  agentChatSend: (id, message, userId = 'default', profileId = null) =>
    post(`/agents/${id}/chat`, {
      message,
      user_id: userId,
      ...(profileId ? { profile_id: profileId } : {}),
    }),
  agentChatFromAgent: (toAgentId, fromAgentId, message) =>
    post(`/agents/${toAgentId}/chat/from-agent`, { from_agent_id: fromAgentId, message }),
  agentActivities: (id) => get(`/agents/${id}/activities`),
  // Standups
  standupsList: (limit) => get(limit ? `/standups?limit=${limit}` : '/standups'),
  standupGet: (id) => get(`/standups/${id}`),
  standupCreate: (body) => post('/standups', body),
  standupNotifications: (limit) => get(limit ? `/standups/notifications?limit=${limit}` : '/standups/notifications'),
  platformNotifications: (limit) =>
    get(limit ? `/platform-notifications?limit=${limit}` : '/platform-notifications'),
  standupUpdate: (id, body) => patch(`/standups/${id}`, body),
  standupResponses: (id) => get(`/standups/${id}/responses`),
  standupAddResponse: (id, agentId, content) => post(`/standups/${id}/responses`, { agent_id: agentId, content }),
  standupRunCoo: (id, includeActivities = false) =>
    post(`/standups/${id}/run-coo${includeActivities ? '?include_activities=1' : ''}`, {}),
  standupMessages: (id) => get(`/standups/${id}/messages`),
  standupSendMessage: (id, body) => post(`/standups/${id}/messages`, body),
  standupApprove: (id) => post(`/standups/${id}/approve`, {}),
  standupDelete: (id) => del(`/standups/${id}`),
  standupDeleteAll: () => del('/standups/all'),
  // Cron: trigger standup collection + COO (agent-to-agent)
  cronRunStandup: () => post('/cron/run-standup', {}),
  cronProcessDelegations: () => post('/cron/process-delegations', {}),
  // OpenClaw: list agents from config and sync to DB
  openclawAgents: () => get('/openclaw/agents'),
  openclawSync: (agentId) => post('/openclaw/sync', agentId ? { agent_id: agentId } : {}),
  // Content tools: metadata (list, update, create, test)
  contentToolsMeta: () => get('/tools/meta'),
  contentToolsMetaUpdate: (name, patch) => patch(`/tools/meta/${encodeURIComponent(name)}`, patch),
  contentToolsMetaCreate: (body) => post('/tools/meta', body),
  contentToolsTest: (name, body = {}) => post(`/tools/test/${encodeURIComponent(name)}`, body),
  // Content tools: monitor logs
  contentToolsLogs: (params = {}) => {
    const sp = new URLSearchParams();
    if (params.limit != null) sp.set('limit', params.limit);
    if (params.offset != null) sp.set('offset', params.offset);
    if (params.tool) sp.set('tool', params.tool);
    const q = sp.toString();
    return get(q ? `/tools/logs?${q}` : '/tools/logs');
  },
  contentToolsLogsCleanup: (params = {}) => {
    const sp = new URLSearchParams();
    if (params.older_than_days != null) sp.set('older_than_days', params.older_than_days);
    if (params.all === true || params.all === '1') sp.set('all', '1');
    const q = sp.toString();
    return del(q ? `/tools/logs?${q}` : '/tools/logs');
  },
  // Broadcast: send message to all or selected agents, collect replies
  broadcastSend: (message, agentIds = null) =>
    post('/broadcast', { message, agent_ids: agentIds && agentIds.length > 0 ? agentIds : undefined }),
  // Kanban
  kanbanTasks: (params = {}) => {
    const sp = new URLSearchParams();
    if (params.view) sp.set('view', params.view);
    if (params.from) sp.set('from', params.from);
    if (params.to) sp.set('to', params.to);
    if (params.limit != null) sp.set('limit', params.limit);
    const q = sp.toString();
    return get(q ? `/kanban/tasks?${q}` : '/kanban/tasks');
  },
  kanbanSummary: (days = 1) => get(`/kanban/summary?days=${days}`),
  kanbanTaskGet: (id) => get(`/kanban/tasks/${id}`),
  kanbanTaskCreate: (body) => post('/kanban/tasks', body),
  kanbanTaskUpdate: (id, body) => patch(`/kanban/tasks/${id}`, body),
  kanbanTaskReopen: (id) => post(`/kanban/tasks/${id}/reopen`, {}),
  kanbanTaskDelete: (id) => del(`/kanban/tasks/${id}`),
  kanbanTasksDeleteBulk: (taskIds) => request('/kanban/tasks', { method: 'DELETE', body: JSON.stringify({ task_ids: taskIds }) }),
  kanbanTaskMessages: (id) => get(`/kanban/tasks/${id}/messages`),
  kanbanTaskAddMessage: (id, role, content) => post(`/kanban/tasks/${id}/messages`, { role, content }),
  jobCeoReviewConfirm: (body) => post('/tools/job-ceo-review-confirm', body),
  jobCeoReviewInclude: (body) => post('/tools/job-ceo-review-include', body),
  jobApplicantReviewQueue: (profileId, ceoUserId = 'default') =>
    get(`/job-applicant/profiles/${encodeURIComponent(profileId)}/review-queue?ceo_user_id=${encodeURIComponent(ceoUserId)}`),
  jobApplicantCeoReviewInclude: (profileId, body) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/ceo-review/include`, body),
  jobApplicantBrowserAuth: () => get('/job-applicant/browser-auth/status'),
  jobApplicantBrowserStartLogin: (body = {}) => post('/job-applicant/browser-auth/start-login', body),
  jobApplicantBrowserCompleteLogin: (body = {}) => post('/job-applicant/browser-auth/complete-login', body),
  jobApplicantBrowserVerifyPortals: (body = {}) => post('/job-applicant/browser-auth/verify-portals', body),
  jobApplicantBrowserSpawnLoginScript: () => post('/job-applicant/browser-auth/spawn-login-script', {}),
  jobRunWorkflowNow: (body) => post('/tools/job-run-workflow-now', body),
  jobApplicantWorkflowRun: (body) => post('/job-applicant/workflow/run', body),
  jobApplicantPipelineStart: (body = {}) => post('/job-applicant/pipeline/start', body),
  jobApplicantPipelineStatus: () => get('/job-applicant/pipeline/status'),
  jobApplicantProfiles: () => get('/job-applicant/profiles'),
  jobApplicantProfileGet: (profileId) => get(`/job-applicant/profiles/${encodeURIComponent(profileId)}`),
  jobApplicantProfileCreate: (body) => post('/job-applicant/profiles', body),
  jobApplicantProfileUpdate: (profileId, body) => patch(`/job-applicant/profiles/${encodeURIComponent(profileId)}`, body),
  jobApplicantProfileConfirm: (profileId, body = {}) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/confirm`, body),
  jobApplicantProfileRename: (profileId, body) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/rename`, body),
  jobApplicantProfileDelete: (profileId, confirm = true) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/delete`, { confirm }),
  jobApplicantProfileDeactivate: (profileId) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/deactivate`, {}),
  jobApplicantWorkflowList: (profileId, limit = 20) =>
    get(`/job-applicant/workflows?profile_id=${encodeURIComponent(profileId)}&limit=${limit}`),
  jobApplicantWorkflowGet: (workflowId) => get(`/job-applicant/workflows/${workflowId}`),
  jobApplicantPortalAuth: (profileId) => get(`/job-applicant/profiles/${encodeURIComponent(profileId)}/portal-auth`),
  jobApplicantConnectPortals: (profileId, body = {}) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/connect-portals`, body),
  jobApplicantHarvestListings: (profileId, body = {}) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/harvest-listings`, body),
  jobApplicantMarkPortalsLoggedIn: (profileId, body = {}) =>
    post(`/job-applicant/profiles/${encodeURIComponent(profileId)}/portals/mark-logged-in`, body),
  authRegister: (body) => post('/auth/register', body),
  authLogin: (body) => post('/auth/login', body),
  authAdminLogin: (body) => post('/auth/admin/login', body),
  authLogout: () => post('/auth/logout', {}),
  authMe: () => get('/auth/me'),
  authUpdateProfile: (body) => patch('/auth/me', body),
  adminUsers: () => get('/admin/users'),
  adminUserGet: (userId) => get(`/admin/users/${encodeURIComponent(userId)}`),
  adminUserSetEnabled: (userId, enabled) => patch(`/admin/users/${encodeURIComponent(userId)}/enabled`, { enabled }),
  adminRegisterUser: (body) => post('/admin/users', body),
  adminGrantStandardAgents: (userId) => post(`/admin/users/${encodeURIComponent(userId)}/agents/grant-standard`, {}),
  adminEnableAgent: (userId, agentId) => post(`/admin/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/enable`, {}),
  adminDisableAgent: (userId, agentId) => post(`/admin/users/${encodeURIComponent(userId)}/agents/${encodeURIComponent(agentId)}/disable`, {}),
  adminAgentsGrouped: () => get('/admin/agents'),
  adminSendNotifications: (body) => post('/admin/notifications', body),
  adminImpersonateUser: (userId) => post(`/admin/users/${encodeURIComponent(userId)}/impersonate`, {}),
  authExitImpersonation: () => post('/auth/exit-impersonation', {}),
  // Agent workflows (custom, separate from job workflows)
  agentWorkflowList: (params = {}) => {
    const q = new URLSearchParams();
    if (params.q) q.set('q', params.q);
    const qs = q.toString();
    return get(`/agent-workflows${qs ? `?${qs}` : ''}`);
  },
  agentWorkflowTemplates: () => get('/agent-workflows/meta/templates'),
  agentWorkflowTemplateGet: (templateId) => get(`/agent-workflows/meta/templates/${encodeURIComponent(templateId)}`),
  agentWorkflowTaskTypes: () => get('/agent-workflows/meta/task-types'),
  agentWorkflowGet: (id) => get(`/agent-workflows/${encodeURIComponent(id)}`),
  agentWorkflowHookInfo: (id) => get(`/agent-workflows/${encodeURIComponent(id)}/hook`),
  agentWorkflowCreate: (body) => post('/agent-workflows', body),
  agentWorkflowUpdate: (id, body) => patch(`/agent-workflows/${encodeURIComponent(id)}`, body),
  agentWorkflowPublish: (id) => post(`/agent-workflows/${encodeURIComponent(id)}/publish`, {}),
  agentWorkflowUnpublish: (id) => post(`/agent-workflows/${encodeURIComponent(id)}/unpublish`, {}),
  agentWorkflowDelete: (id) => del(`/agent-workflows/${encodeURIComponent(id)}`),
  agentWorkflowAudit: (id, limit = 50) => get(`/agent-workflows/${encodeURIComponent(id)}/audit?limit=${limit}`),
  agentWorkflowRuns: ({ page = 1, limit = 20, q = '' } = {}) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (q) params.set('q', q);
    return get(`/agent-workflows/runs?${params}`);
  },
  agentWorkflowRunGet: (runId) => get(`/agent-workflows/runs/${runId}`),
  agentWorkflowStopListen: (runId, nodeId) =>
    post(`/agent-workflows/runs/${runId}/listen/${encodeURIComponent(nodeId)}/stop`, {}),
  agentWorkflowRunsForDef: (id, limit = 30) => get(`/agent-workflows/${encodeURIComponent(id)}/runs?limit=${limit}`),
  agentWorkflowRun: (id, body = {}) => post(`/agent-workflows/${encodeURIComponent(id)}/run`, body),
  agentWorkflowApprovalRespond: (body) => post('/agent-workflows/approval/respond', body),
  agentWorkflowPause: (id) => post(`/agent-workflows/${encodeURIComponent(id)}/pause`, {}),
  agentWorkflowResume: (id) => post(`/agent-workflows/${encodeURIComponent(id)}/resume`, {}),
  agentWorkflowUpdateTriggers: (id, body) => patch(`/agent-workflows/${encodeURIComponent(id)}/triggers`, body),
  agentWorkflowRunPause: (runId) => post(`/agent-workflows/runs/${runId}/pause`, {}),
  agentWorkflowRunDelete: (runId) => del(`/agent-workflows/runs/${runId}`),
  agentWorkflowRunsPauseAll: (definitionId = null) =>
    post('/agent-workflows/runs/pause-all', definitionId ? { definition_id: definitionId } : {}),
  agentWorkflowRunsDeleteAll: (definitionId = null) => {
    const q = definitionId ? `?definition_id=${encodeURIComponent(definitionId)}` : '';
    return del(`/agent-workflows/runs/all${q}`);
  },
  agentWorkflowAgentChat: (body) => post('/agent-workflows/agent-chat', body),
  agentWorkflowAgentChatHistory: (workflowId = null, limit = 100) => {
    const q = new URLSearchParams();
    if (workflowId) q.set('workflow_id', workflowId);
    q.set('limit', String(limit));
    return get(`/agent-workflows/agent-chat/history?${q}`);
  },
  agentWorkflowDraftGet: (id) => get(`/agent-workflows/draft/${encodeURIComponent(id)}`),
  agentWorkflowMutate: (body) => post('/agent-workflows/mutate', body),
  // Clear OpenClaw sessions for an agent (workspace UI)
  agentSessionsClear: (agentId) => post(`/agents/${encodeURIComponent(agentId)}/sessions/clear`, {}),
  // MCP integrations
  mcpServersList: (opts = {}) => {
    const q = opts.forWorkflow ? '?for_workflow=1' : '';
    return get(`/integrations/mcp${q}`);
  },
  mcpServerGet: (id) => get(`/integrations/mcp/${encodeURIComponent(id)}`),
  mcpServerCreate: (body) => post('/integrations/mcp', body),
  mcpServerUpdate: (id, body) => patch(`/integrations/mcp/${encodeURIComponent(id)}`, body),
  mcpServerDelete: (id) => del(`/integrations/mcp/${encodeURIComponent(id)}`),
  mcpServerConnect: (id, body = {}) => post(`/integrations/mcp/${encodeURIComponent(id)}/connect`, body),
  mcpServerCallTool: (id, toolName, args, body = {}) =>
    post(`/integrations/mcp/${encodeURIComponent(id)}/tools/${encodeURIComponent(toolName)}/call`, {
      arguments: args,
      ...body,
    }),
  mcpServerLogs: (id, limit = 20) => get(`/integrations/mcp/${encodeURIComponent(id)}/logs?limit=${limit}`),

  externalAgentsList: (opts = {}) => {
    const q = opts.forWorkflow ? '?for_workflow=1' : '';
    return get(`/integrations/external-agents${q}`);
  },
  externalAgentGet: (id) => get(`/integrations/external-agents/${encodeURIComponent(id)}`),
  externalAgentCreate: (body) => post('/integrations/external-agents', body),
  externalAgentUpdate: (id, body) => patch(`/integrations/external-agents/${encodeURIComponent(id)}`, body),
  externalAgentDelete: (id) => del(`/integrations/external-agents/${encodeURIComponent(id)}`),
  externalAgentDiscover: (id) => post(`/integrations/external-agents/${encodeURIComponent(id)}/discover`, {}),
  externalAgentInvoke: (id, body) => post(`/integrations/external-agents/${encodeURIComponent(id)}/invoke`, body),

  customScriptsList: (opts = {}) => {
    const q = opts.forWorkflow ? '?for_workflow=1' : '';
    return get(`/integrations/custom-scripts${q}`);
  },
  customScriptGet: (id, opts = {}) => {
    const q = opts.includeSource ? '?include_source=1' : '';
    return get(`/integrations/custom-scripts/${encodeURIComponent(id)}${q}`);
  },
  customScriptScan: (body) => post('/integrations/custom-scripts/scan', body),
  customScriptCreate: (body) => post('/integrations/custom-scripts', body),
  customScriptUpdate: (id, body) => patch(`/integrations/custom-scripts/${encodeURIComponent(id)}`, body),
  customScriptDelete: (id) => del(`/integrations/custom-scripts/${encodeURIComponent(id)}`),
  customScriptExecute: (id, body = {}) =>
    post(`/integrations/custom-scripts/${encodeURIComponent(id)}/execute`, body),
};
