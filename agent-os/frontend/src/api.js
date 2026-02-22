const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
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

export const api = {
  health: () => get('/health'),
  // Workspace (OpenClaw MD files) — legacy single-workspace (optional)
  workspaceFiles: () => get('/workspace/files'),
  workspaceRead: (name) => get(`/workspace/files/${encodeURIComponent(name)}`),
  workspaceWrite: (name, text) => put(`/workspace/files/${encodeURIComponent(name)}`, { text }),
  // Per-agent workspace (MD files)
  agentWorkspaceFiles: (agentId) => get(`/agents/${encodeURIComponent(agentId)}/workspace/files`),
  agentWorkspaceRead: (agentId, name) => get(`/agents/${encodeURIComponent(agentId)}/workspace/files/${encodeURIComponent(name)}`),
  agentWorkspaceWrite: (agentId, name, text) => put(`/agents/${encodeURIComponent(agentId)}/workspace/files/${encodeURIComponent(name)}`, { text }),
  // Agents
  agentsList: () => get('/agents'),
  agentGet: (id) => get(`/agents/${id}`),
  agentCreate: (body) => post('/agents', body),
  agentUpdate: (id, body) => patch(`/agents/${id}`, body),
  agentDelete: (id) => del(`/agents/${id}`),
  agentChatHistory: (id) => get(`/agents/${id}/chat`),
  agentChatSend: (id, message, userId = 'default') => post(`/agents/${id}/chat`, { message, user_id: userId }),
  agentChatFromAgent: (toAgentId, fromAgentId, message) =>
    post(`/agents/${toAgentId}/chat/from-agent`, { from_agent_id: fromAgentId, message }),
  agentActivities: (id) => get(`/agents/${id}/activities`),
  // Standups
  standupsList: (limit) => get(limit ? `/standups?limit=${limit}` : '/standups'),
  standupGet: (id) => get(`/standups/${id}`),
  standupCreate: (body) => post('/standups', body),
  standupUpdate: (id, body) => patch(`/standups/${id}`, body),
  standupResponses: (id) => get(`/standups/${id}/responses`),
  standupAddResponse: (id, agentId, content) => post(`/standups/${id}/responses`, { agent_id: agentId, content }),
  standupRunCoo: (id, includeActivities = false) =>
    post(`/standups/${id}/run-coo${includeActivities ? '?include_activities=1' : ''}`, {}),
  standupMessages: (id) => get(`/standups/${id}/messages`),
  standupSendMessage: (id, body) => post(`/standups/${id}/messages`, body),
  standupApprove: (id) => post(`/standups/${id}/approve`, {}),
  standupDelete: (id) => del(`/standups/${id}`),
  // Cron: trigger standup collection + COO (agent-to-agent)
  cronRunStandup: () => post('/cron/run-standup', {}),
  cronProcessDelegations: () => post('/cron/process-delegations', {}),
};
