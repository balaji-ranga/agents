/**
 * OpenClaw plugin: registers content tools from the Agent OS tools list file.
 * File path: OPENCLAW_TOOLS_LIST_PATH or ~/.openclaw/agent-os-tools.json.
 * Each tool calls the backend POST /api/tools/invoke with tool_name and params.
 * Restart the gateway after adding/removing tools so the file is re-read.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const OPENCLAW_DIR = join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw");
const DEFAULT_TOOLS_LIST_PATH = join(OPENCLAW_DIR, "agent-os-tools.json");

function getToolsListPath(): string {
  return process.env.OPENCLAW_TOOLS_LIST_PATH || DEFAULT_TOOLS_LIST_PATH;
}

interface ToolEntry {
  name: string;
  display_name?: string;
  endpoint?: string;
  method?: string;
  purpose?: string;
}

function loadToolsFromFile(): ToolEntry[] {
  const path = getToolsListPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Parse agent id from OpenClaw session key (e.g. "agent::techresearcher:main" -> "techresearcher"). */
function agentIdFromSessionKey(sessionKey: string | undefined): string | null {
  if (!sessionKey || typeof sessionKey !== "string") return null;
  const m = sessionKey.match(/^agent::([^:]+):/);
  return m ? m[1] : null;
}

export default function (api: { registerTool: Function; config: Record<string, unknown>; context?: unknown; sessionKey?: string; getSessionKey?: () => string }) {
  const pluginConfig = (api.config?.plugins as Record<string, unknown>)?.entries?.["agent-os-content-tools"] as Record<string, unknown> | undefined;
  const baseUrl = (pluginConfig?.config as Record<string, unknown>)?.baseUrl as string | undefined
    || process.env.AGENT_OS_API_URL
    || "";
  const apiKey = (pluginConfig?.config as Record<string, unknown>)?.apiKey as string | undefined
    || process.env.TOOLS_API_KEY
    || "";

  function getBaseUrl(): string {
    return (baseUrl?.trim() || "").replace(/\/$/, "");
  }

  /** Resolve caller agent id from api context (sessionKey, context.agentId, etc.) so backend can authorize Kanban tools. */
  function resolveCallerAgentId(params: Record<string, unknown>): string | null {
    const fromParams =
      (params?.__openclaw_agent_id as string) ||
      (params?.caller_agent_id as string) ||
      (params?.agent_id as string) ||
      null;
    if (fromParams && String(fromParams).trim()) return String(fromParams).trim();

    const a = api as Record<string, unknown>;
    const sessionKey = (typeof a.getSessionKey === "function" ? a.getSessionKey() : a.sessionKey) as string | undefined;
    const fromSession = agentIdFromSessionKey(sessionKey);
    if (fromSession) return fromSession;

    const ctx = a.context as Record<string, unknown> | undefined;
    const fromCtx = ctx?.agentId ?? ctx?.agent_id;
    if (fromCtx && typeof fromCtx === "string") return fromCtx;
    return null;
  }

  async function callInvoke(
    toolName: string,
    params: Record<string, unknown>,
    callerAgentId?: string | null
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const url = getBaseUrl();
    if (!url) {
      return { ok: false, error: "Agent OS backend URL not set. Set plugins.entries['agent-os-content-tools'].config.baseUrl or AGENT_OS_API_URL." };
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const body: Record<string, unknown> = { tool_name: toolName, ...params };
    if (callerAgentId) body.caller_agent_id = callerAgentId;
    try {
      const res = await fetch(`${url}/api/tools/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: (data as { error?: string }).error || res.statusText };
      }
      return { ok: true, data };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  const tools = loadToolsFromFile();
  const kanbanMoveStatusParams = {
    type: "object" as const,
    properties: {
      task_id: { type: "number", description: "Kanban task ID (number)." },
      new_status: { type: "string", enum: ["open", "awaiting_confirmation", "in_progress", "completed", "failed"], description: "New status for the task." },
    },
    additionalProperties: true,
  };
  const paramSchemas: Record<string, Record<string, unknown>> = {
    kanban_move_status: kanbanMoveStatusParams,
    kanban_reassign_to_coo: { type: "object" as const, properties: { task_id: { type: "number", description: "Kanban task ID." } }, additionalProperties: true },
    kanban_assign_task: { type: "object" as const, properties: { task_id: { type: "number" }, to_agent_id: { type: "string" } }, additionalProperties: true },
  };
  for (const t of tools) {
    const name = t?.name;
    if (!name || typeof name !== "string") continue;
    const description = (t.purpose || t.display_name || name) as string;
    const apiToolNote = " Invoke this tool by name with JSON parameters (API call); do not use exec or run as a shell command.";
    const parameters = paramSchemas[name] || { type: "object" as const, properties: {} as Record<string, unknown>, additionalProperties: true };
    api.registerTool(
      {
        name,
        description: description + apiToolNote + " Prefer this tool when applicable before using other built-in tools.",
        parameters,
        async execute(_id: string, params: Record<string, unknown>) {
          const raw = params || {};
          const callerAgentId = resolveCallerAgentId(raw);
          const { __openclaw_agent_id, caller_agent_id, agent_id, ...rest } = raw;
          const result = await callInvoke(name, rest, callerAgentId);
          const text = result.ok ? JSON.stringify(result.data) : JSON.stringify({ error: result.error });
          return { content: [{ type: "text" as const, text }] };
        },
      },
      { optional: true }
    );
  }
}
