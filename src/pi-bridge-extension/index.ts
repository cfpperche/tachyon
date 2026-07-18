import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { projectMcpTool, type McpToolCallResult, type McpToolDescriptor } from "./toolProjection.js";

const STATUS_KEY = "tachyon-bridge";

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

interface PiExtensionApi {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: { ui: { notify(message: string, level: "info" | "warning"): void } }): Promise<void>;
  }): void;
  registerTool(tool: unknown): void;
  on(event: "session_start", handler: (event: unknown, ctx: { ui: { setStatus(key: string, value: string): void } }) => void): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
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

  pi.on("session_start", (_event, ctx) => {
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
