import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BridgeDeps, fail, ok } from "./shared.js";

export function registerIdeBrowserTools(mcp: McpServer, deps: BridgeDeps): void {

  // Prototype: VS Code Integrated Browser via shell HTTP+CDP bridge (thimo-style).
  // Always register when the engine wires `ideBrowserRequest` (or tests enable the gate).
  // Do NOT gate on "instance file is live right now" — MCP sessions freeze the tool catalog
  // at connect, and agents spawned before Design Mode would never see design_mode_chat_reply.
  // Offline calls fail closed via bridge_offline from the client (companion-style).
  // t-7aef5a — disambiguate from user_browser_* (Companion) and agent-browser plugin tools.
  const IDE_BROWSER_SCOPE =
    "[VS Code Integrated Browser — editor Chromium tab + Design Mode; NOT Companion user_browser_* and NOT agent-browser] ";
  if (deps.ideBrowserRequest || deps.ideBrowserToolsEnabled?.()) {
    const ideReq = async (route: string, body?: Record<string, unknown>) => {
      if (!deps.ideBrowserRequest) {
        return { ok: false as const, error: "ideBrowserRequest not wired on this engine" };
      }
      return deps.ideBrowserRequest(route, body);
    };

    mcp.registerTool(
      "ide_browser_status",
      {
        description:
          IDE_BROWSER_SCOPE +
          "Status of the IDE browser host (CDP). Use before other ide_browser_* tools. " +
          "Offline means the VS Code shell is not running the Integrated Browser bridge.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await ideReq("/status");
          if (!result.ok) return fail(new Error(result.error || "ide_browser_status failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "ide_browser_navigate",
      {
        description:
          IDE_BROWSER_SCOPE +
          "Navigate the editor Integrated Browser tab to a URL. Lazily launches editor-browser on first use.",
        inputSchema: {
          url: z.string().min(1).max(4000).describe("Absolute http(s) URL or host to open"),
        },
      },
      async ({ url }) => {
        try {
          const result = await ideReq("/navigate", { url });
          if (!result.ok) return fail(new Error(result.error || "ide_browser_navigate failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "ide_browser_screenshot",
      {
        description:
          IDE_BROWSER_SCOPE +
          "Capture a PNG screenshot of the Integrated Browser viewport (base64).",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await ideReq("/screenshot");
          if (!result.ok) return fail(new Error(result.error || "ide_browser_screenshot failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "ide_browser_snapshot",
      {
        description:
          IDE_BROWSER_SCOPE +
          "Accessibility / text snapshot of the current Integrated Browser page.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await ideReq("/snapshot");
          if (!result.ok) return fail(new Error(result.error || "ide_browser_snapshot failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "ide_browser_eval",
      {
        description:
          IDE_BROWSER_SCOPE +
          "Evaluate JavaScript in the Integrated Browser page (DevTools-equivalent). " +
          "Examples: document.querySelector('h1').style.color='red'.",
        inputSchema: {
          expression: z.string().min(1).max(50_000).describe(
            "JS expression/statement to evaluate in the page context",
          ),
        },
      },
      async ({ expression }) => {
        try {
          const result = await ideReq("/eval", { expression });
          if (!result.ok) return fail(new Error(result.error || "ide_browser_eval failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "ide_browser_click",
      {
        description:
          IDE_BROWSER_SCOPE +
          "Click an element by CSS selector (prefer Design Mode pick selector hints).",
        inputSchema: {
          selector: z.string().min(1).max(1000).describe("CSS selector"),
        },
      },
      async ({ selector }) => {
        try {
          const result = await ideReq("/click", { selector });
          if (!result.ok) return fail(new Error(result.error || "ide_browser_click failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "ide_browser_url",
      {
        description: IDE_BROWSER_SCOPE + "Return the current URL of the Integrated Browser page.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await ideReq("/url");
          if (!result.ok) return fail(new Error(result.error || "ide_browser_url failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "design_mode_chat_reply",
      {
        description:
          IDE_BROWSER_SCOPE +
          "Post a plain-language reply into the Design Mode chat panel. " +
          "Required when the human messaged you from Design Mode — the panel only updates via this tool. " +
          "Plain answer only: no tool narration, no JSON dumps, no terminal-only reply.",
        inputSchema: {
          text: z.string().min(1).max(12_000).describe("Plain answer for the human chat panel"),
          agent: z
            .string()
            .min(1)
            .max(120)
            .optional()
            .describe("Ignored if it does not match the Design Mode active agent; speaker defaults to that agent"),
        },
      },
      async ({ text, agent }) => {
        try {
          // Prefer authenticated caller name when available (ignore spoofed speaker).
          const callerName =
            deps.caller?.kind === "agent" && deps.caller.name ? deps.caller.name : undefined;
          const speaker = callerName ?? agent;
          const result = await ideReq("/design-mode/chat-reply", {
            text,
            ...(speaker ? { agent: speaker } : {}),
          });
          if (!result.ok) return fail(new Error(result.error || "design_mode_chat_reply failed"));
          return ok(JSON.stringify(result.data, null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }
}
