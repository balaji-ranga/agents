/**
 * Agent OS Bootstrap Watcher — reload workspace MD files from disk on every agent:bootstrap.
 * Workspace UI writes SOUL.md / AGENTS.md / TOOLS.md / MEMORY.md directly to the agent folder;
 * this hook replaces cached bootstrap content so the next agent turn sees fresh files.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "memory.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

type WorkspaceBootstrapFile = {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
};

type InternalHookEvent = {
  type: string;
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
};

type PluginLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

function registerInternalHook(
  eventKey: string,
  handler: (event: InternalHookEvent) => Promise<void> | void
): void {
  const g = globalThis as Record<string, unknown>;
  type Handler = (event: InternalHookEvent) => Promise<void> | void;
  let handlers = g.__openclaw_internal_hook_handlers__ as Map<string, Set<Handler>> | undefined;
  if (!handlers) {
    handlers = new Map();
    g.__openclaw_internal_hook_handlers__ = handlers;
  }
  if (!handlers.has(eventKey)) handlers.set(eventKey, new Set());
  handlers.get(eventKey)!.add(handler);
}

function resolveUserPath(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1).replace(/^[/\\]/, ""));
  return resolve(p);
}

async function reloadBootstrapFiles(workspaceDir: string): Promise<WorkspaceBootstrapFile[]> {
  const dir = resolveUserPath(workspaceDir);
  const result: WorkspaceBootstrapFile[] = [];
  for (const name of BOOTSTRAP_FILE_NAMES) {
    const filePath = join(dir, name);
    try {
      const content = await readFile(filePath, "utf-8");
      result.push({ name, path: filePath, content, missing: false });
    } catch {
      result.push({ name, path: filePath, missing: true });
    }
  }
  return result;
}

const plugin = {
  id: "agent-os-bootstrap-watcher",
  name: "Agent OS Bootstrap Watcher",
  description:
    "Reload agent bootstrap MD files from disk on every turn so Workspace UI edits apply without gateway restart.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },

  register(api: { logger?: PluginLogger }) {
    const log: PluginLogger = api.logger ?? console;

    registerInternalHook("agent:bootstrap", async (event: InternalHookEvent) => {
      const workspaceDir = event.context?.workspaceDir as string | undefined;
      if (!workspaceDir) return;
      try {
        const freshFiles = await reloadBootstrapFiles(workspaceDir);
        event.context.bootstrapFiles = freshFiles;
        const loaded = freshFiles.filter((f) => !f.missing).length;
        log.info?.(
          `[agent-os-bootstrap-watcher] Fresh bootstrap (${loaded} file(s)) from ${resolveUserPath(workspaceDir)}`
        );
      } catch (err) {
        log.error?.(`[agent-os-bootstrap-watcher] Failed to reload bootstrap files: ${err}`);
      }
    });

    log.info?.("[agent-os-bootstrap-watcher] Hook registered — workspace MD edits apply on next agent turn.");
  },
};

export default plugin;
