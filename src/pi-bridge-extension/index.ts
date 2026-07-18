import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { projectMcpTool, type McpToolCallResult, type McpToolDescriptor } from "./toolProjection.js";

const STATUS_KEY = "tachyon-bridge";
const PI_OWNER_FILE_ENV = "TACHYON_PI_SESSION_OWNER_FILE";
const AGENT_NAME_ENV = "TACHYON_AGENT_NAME";

function environment(): { url?: string; token?: string } {
  return {
    url: process.env.TACHYON_BRIDGE_URL?.trim() || undefined,
    token: process.env.TACHYON_AGENT_BRIDGE_TOKEN?.trim()
      || process.env.TACHYON_BRIDGE_TOKEN?.trim()
      || undefined,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PiSessionContext {
  ui: { setStatus(key: string, value: string): void };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getCwd(): string;
  };
}

interface PiExtensionApi {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: { ui: { notify(message: string, level: "info" | "warning"): void } }): Promise<void>;
  }): void;
  registerTool(tool: unknown): void;
  on(event: "session_start", handler: (event: { reason?: string }, ctx: PiSessionContext) => void): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
}

/** Append exact positive ownership for startup and in-TUI new/resume/fork rotations. */
function recordSessionOwner(event: { reason?: string }, ctx: PiSessionContext): void {
  const file = process.env[PI_OWNER_FILE_ENV]?.trim();
  const agent = process.env[AGENT_NAME_ENV]?.trim();
  if (!file || !agent) return;
  const sessionId = ctx.sessionManager.getSessionId();
  const transcriptPath = ctx.sessionManager.getSessionFile();
  const cwd = ctx.sessionManager.getCwd();
  if (!sessionId || !transcriptPath || !cwd) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      agent,
      sessionId,
      transcriptPath,
      cwd,
      source: `pi:${event.reason ?? "unknown"}`,
      ts: new Date().toISOString(),
    })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Ownership is fail-closed at Fork resolution. Never prevent Pi startup if local evidence storage fails.
  }
}

export default async function tachyonPiBridge(pi: PiExtensionApi): Promise<void> {
  const env = environment();
  let state = "not configured";
  let client: Client | undefined;
  let toolCount = 0;

  pi.registerCommand("tachyon-bridge-status", {
    description: "Show this Pi agent's Tachyon Bridge connection status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Tachyon Bridge: ${state}`, state.startsWith("connected") ? "info" : "warning");
    },
  });

  pi.on("session_start", (event, ctx) => {
    recordSessionOwner(event, ctx);
    ctx.ui.setStatus(STATUS_KEY, state.startsWith("connected") ? `Tachyon ${toolCount} tools` : "Tachyon disconnected");
  });
  pi.on("session_shutdown", async () => {
    const closing = client;
    client = undefined;
    if (closing) await closing.close().catch(() => undefined);
  });

  if (!env.url) {
    state = "disconnected (TACHYON_BRIDGE_URL is missing)";
    return;
  }
  if (!env.token) {
    state = "disconnected (Bridge bearer token is missing)";
    return;
  }

  try {
    const transport = new StreamableHTTPClientTransport(new URL(env.url), {
      requestInit: { headers: { Authorization: `Bearer ${env.token}` } },
    });
    const connected = new Client({ name: "tachyon-pi", version: "1.0.0" });
    await connected.connect(transport, { timeout: 5_000 });
    client = connected;

    const refresh = async (): Promise<void> => {
      const catalog = await connected.listTools(undefined, { timeout: 5_000 });
      const caller = {
        callTool: async (
          input: { name: string; arguments: Record<string, unknown> },
          _resultSchema?: unknown,
          options?: { signal?: AbortSignal },
        ): Promise<McpToolCallResult> => connected.callTool(
          input,
          undefined,
          { ...options, timeout: 300_000 },
        ) as Promise<McpToolCallResult>,
      };
      for (const descriptor of catalog.tools as McpToolDescriptor[]) {
        // Pi's validator explicitly accepts ordinary JSON Schema in addition to TypeBox schemas.
        pi.registerTool(projectMcpTool(descriptor, caller, (input) => input));
      }
      toolCount = catalog.tools.length;
      state = `connected (${toolCount} tools)`;
    };

    connected.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await refresh();
      } catch (error) {
        state = `tool refresh failed (${message(error)})`;
      }
    });
    await refresh();
  } catch (error) {
    state = `disconnected (${message(error)})`;
    if (client) await client.close().catch(() => undefined);
    client = undefined;
  }
}
