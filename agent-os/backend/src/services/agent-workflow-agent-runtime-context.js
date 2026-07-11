/**
 * Runtime environment snapshot for the Workflow Builder agent — agents, MCP, tools, defaults.
 */
import { listToolsMeta } from './content-tools-meta.js';
import { listAgentsForUser, getUserById } from './users.js';
import { listMcpServersForWorkflow } from './mcp-servers.js';
import { getWorkflowTemplates } from './agent-workflow-templates.js';
import { defaultNodeConfig } from './agent-workflow-task-catalog.js';

export function defaultBrainConfig() {
  const cfg = defaultNodeConfig('brain');
  return {
    ...cfg,
    modelSource: process.env.BRAIN_MCP_TEST_PROVIDER === 'openai' ? 'openai' : 'ollama',
    apiEndpoint: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    model:
      process.env.OPENAI_PRIMARY_MODEL ||
      process.env.OLLAMA_MODEL ||
      process.env.OPENCLAW_OLLAMA_MODEL ||
      'llama3.2',
    maxTokens: 512,
    systemPrompt: 'You are a concise assistant.\n\nContext:\n{{input}}',
    mcpToolCalling: false,
    mcpServerIds: [],
    mcpToolAllowlist: [],
    mcpMaxToolRounds: 8,
    mcpServerAuth: {},
    httpHeadersJson: '{}',
  };
}

export function buildWorkflowAgentRuntimeContext(ownerUserId) {
  const authUser = getUserById(ownerUserId) || { id: ownerUserId, role: 'ceo' };

  const agents = listAgentsForUser(ownerUserId).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role || '',
  }));

  const mcpServers = listMcpServersForWorkflow(authUser).map((s) => ({
    id: s.id,
    name: s.name,
    base_url: s.base_url || '',
    tools: (s.tools || []).slice(0, 25).map((t) => t.name),
    prompts: (s.prompts || []).slice(0, 8).map((p) => p.name),
  }));

  const contentTools = listToolsMeta()
    .filter((t) => t.enabled !== 0 && t.enabled !== false)
    .map((t) => ({ name: t.name, display_name: t.display_name, purpose: t.purpose || '' }));

  const templates = getWorkflowTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    default_chat_phrase: t.default_chat_phrase || '',
    category: t.category || '',
  }));

  const brain = defaultBrainConfig();
  const firstMcp = mcpServers[0]?.id || null;

  return {
    agents,
    mcpServers,
    contentTools,
    templates,
    defaults: {
      brain,
      firstMcpId: firstMcp,
      trigger_modes: ['manual', 'chat'],
      ollama_base: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
      ollama_model: process.env.OLLAMA_MODEL || 'llama3.2',
    },
  };
}

export function formatRuntimeContextForPrompt(ctx) {
  const lines = ['\n## Runtime environment (use these IDs — do not invent)'];

  if (ctx.agents?.length) {
    lines.push(
      '\nAgents:',
      ctx.agents.map((a) => `- ${a.name} (id: ${a.id})`).join('\n')
    );
  } else {
    lines.push('\nAgents: (none granted — use brain nodes instead of agent nodes)');
  }

  if (ctx.mcpServers?.length) {
    lines.push(
      '\nMCP servers (healthy):',
      ctx.mcpServers
        .map(
          (s) =>
            `- ${s.name} (id: ${s.id}) tools: [${(s.tools || []).join(', ')}]${s.prompts?.length ? ` prompts: [${s.prompts.join(', ')}]` : ''}`
        )
        .join('\n')
    );
  } else {
    lines.push('\nMCP servers: none healthy — skip mcp_tool / mcp listen unless user provides server id');
  }

  if (ctx.contentTools?.length) {
    lines.push(
      '\nContent tools:',
      ctx.contentTools.slice(0, 15).map((t) => `- ${t.name}: ${t.purpose || t.display_name}`).join('\n')
    );
  }

  if (ctx.templates?.length) {
    lines.push(
      '\nBuilt-in templates (prefer create_from_template when intent matches):',
      ctx.templates.map((t) => `- ${t.id}: ${t.name} — ${t.description}`).join('\n')
    );
  }

  lines.push(
    '\nDefault brain config (copy into task_config unless user specifies otherwise):',
    'Brain nodes must include apiKey on the node — platform .env API keys are never used for workflow runs.',
    JSON.stringify(ctx.defaults?.brain || {}, null, 2),
    `\nDefault MCP server if needed: ${ctx.defaults?.firstMcpId || '(none)'}`
  );

  return lines.join('\n');
}
