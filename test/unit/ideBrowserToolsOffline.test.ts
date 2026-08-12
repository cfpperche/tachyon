/**
 * t-3cab05 / SDD 488 Phase 0 — pin always-register + offline fail-closed for ide_browser_*.
 *
 * Why this exists: MCP sessions freeze the tool catalog at connect. Gating registration on a live
 * instance file meant agents spawned before Design Mode never saw design_mode_chat_reply for the
 * life of the session (src/bridge/tools/ide-browser.ts:8-11). Companion already taught the pattern:
 * list tools always; fail closed at call time with bridge_offline.
 *
 * The F3 runtime matrix t-dd46a4 established the shared offline envelope across every CLI.
 * t-7a4c36 updates only its guidance: agents can edit the opt-in or report extension inactivity,
 * but cannot execute a VS Code palette command themselves.
 * Streams: docs/research/evidence-t-dd46a4-f3/claude4-stdout.jsonl (tool_result),
 *          codex2-stdout.jsonl (item.completed content[0].text),
 *          grok-chat-tool-calls.jsonl (Failed to call …: error: IDE browser…).
 * Write-up: docs/research/design-mode-chat-reply-runtime-matrix-t-dd46a4.md
 */
import { describe, expect, it } from "vitest";
import { registerIdeBrowserTools } from "../../src/bridge/tools/ide-browser.js";
import type { BridgeDeps } from "../../src/bridge/tools/shared.js";
import {
  ideBrowserRequest as clientIdeBrowserRequest,
  isIdeBrowserBridgeAvailable,
} from "../../src/ide-browser/client.js";

/** Exact MCP tool-result text returned to every runtime when the bridge is offline. */
const OFFLINE_TOOL_RESULT =
  "error: IDE browser bridge offline. Ensure settings.ideBrowser.enabled is true in tachyon.yml and the Tachyon extension is active for this workspace.";

/** Client-layer message (without the tool `error: ` prefix) from ideBrowserRequest when no instance. */
const CLIENT_OFFLINE_ERROR =
  "IDE browser bridge offline. Ensure settings.ideBrowser.enabled is true in tachyon.yml and the Tachyon extension is active for this workspace.";

const IDE_BROWSER_TOOL_NAMES = [
  "ide_browser_status",
  "ide_browser_navigate",
  "ide_browser_screenshot",
  "ide_browser_snapshot",
  "ide_browser_eval",
  "ide_browser_click",
  "ide_browser_url",
  "design_mode_chat_reply",
] as const;

type ToolResult = { content: Array<{ type?: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

class FakeMcp {
  handlers = new Map<string, ToolHandler>();
  registerTool(name: string, _def: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

function wire(deps: Partial<BridgeDeps>): FakeMcp {
  const mcp = new FakeMcp();
  registerIdeBrowserTools(mcp as never, {
    workspaceRoot: "/tmp/tachyon-no-ide-browser-instance",
    ...deps,
  } as BridgeDeps);
  return mcp;
}

describe("t-3cab05 — ide_browser tools always-register + offline fail-closed", () => {
  it("registers all ide_browser_* tools when only ideBrowserRequest is wired (no live instance)", () => {
    // Phase 0: mock deps with ideBrowserRequest only — no instance file, no status probe.
    const mcp = wire({
      ideBrowserRequest: async () => ({ ok: false, code: "bridge_offline", error: CLIENT_OFFLINE_ERROR }),
    });

    for (const name of IDE_BROWSER_TOOL_NAMES) {
      expect(mcp.handlers.has(name), `expected ${name} to be registered offline`).toBe(true);
    }
  });

  it("does not register tools when ideBrowserRequest is absent (and the legacy gate is off)", () => {
    const mcp = wire({});
    for (const name of IDE_BROWSER_TOOL_NAMES) {
      expect(mcp.handlers.has(name), `expected ${name} omitted without wiring`).toBe(false);
    }
  });

  it("isIdeBrowserBridgeAvailable is a status probe, not a registration gate", () => {
    const syntheticRoot = "/tmp/tachyon-no-such-workspace-ide-browser-offlineenv";
    expect(isIdeBrowserBridgeAvailable(syntheticRoot)).toBe(false);

    // Still registers when the engine wires the request fn — availability never gates the catalog.
    const mcp = wire({
      ideBrowserRequest: (route, body) => clientIdeBrowserRequest(syntheticRoot, route, body),
    });
    expect(mcp.handlers.has("design_mode_chat_reply")).toBe(true);
    expect(mcp.handlers.has("ide_browser_status")).toBe(true);
  });

  it("offline design_mode_chat_reply returns the F3-observed error envelope (not missing tool)", async () => {
    const syntheticRoot = "/tmp/tachyon-no-such-workspace-ide-browser-offlineenv";
    const mcp = wire({
      ideBrowserRequest: (route, body) => clientIdeBrowserRequest(syntheticRoot, route, body),
    });

    const handler = mcp.handlers.get("design_mode_chat_reply");
    expect(handler, "tool must be registered so offline is a call error, not a missing tool").toBeDefined();

    const res = await handler!({ text: "matrix probe alpha ok", turnId: "dm-turn-f3matrix01" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe(OFFLINE_TOOL_RESULT);
  });

  it("forwards a structured edit through the existing bound reply door", async () => {
    const requests: Array<{ route: string; body?: Record<string, unknown> }> = [];
    const mcp = wire({
      ideBrowserRequest: async (route, body) => {
        requests.push({ route, body });
        return { ok: true, data: { accepted: true } };
      },
    });

    const handler = mcp.handlers.get("design_mode_chat_reply");
    const edit = {
      summary: "Increase button padding",
      files: ["src/button.css"],
      patch: "diff --git a/src/button.css b/src/button.css\n@@ -1 +1 @@\n-padding: 4px\n+padding: 8px",
    };
    const res = await handler!({ text: "Done.", turnId: "dm-turn-edit", edit });

    expect(res.isError).not.toBe(true);
    expect(requests).toEqual([{
      route: "/design-mode/chat-reply",
      body: { text: "Done.", turnId: "dm-turn-edit", edit },
    }]);
  });

  it("offline ide_browser_status returns the same F3-observed envelope", async () => {
    const syntheticRoot = "/tmp/tachyon-no-such-workspace-ide-browser-offlineenv";
    const mcp = wire({
      ideBrowserRequest: (route, body) => clientIdeBrowserRequest(syntheticRoot, route, body),
    });

    const handler = mcp.handlers.get("ide_browser_status");
    expect(handler).toBeDefined();
    const res = await handler!({});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe(OFFLINE_TOOL_RESULT);
  });

  it("client offline envelope carries bridge_offline code and actionable agent guidance", async () => {
    const env = await clientIdeBrowserRequest(
      "/tmp/tachyon-no-such-workspace-ide-browser-offlineenv",
      "/status",
    );
    // `IdeBrowserEnvelope` is a discriminated union; narrow on `ok` before reading the failure
    // fields, or `code`/`error` do not exist on the success arm. `expect(env.ok).toBe(false)` is a
    // runtime assertion and narrows nothing for tsc — vitest passing is not a typecheck.
    if (env.ok) throw new Error("expected the offline envelope to be a failure");
    expect(env.code).toBe("bridge_offline");
    expect(env.error).toBe(CLIENT_OFFLINE_ERROR);
    expect(env.error).not.toContain("IDE Browser Bridge Start");
    // Tool layer prefixes with `error: ` via fail(), preserving the shared envelope shape F3 proved.
    expect(`error: ${env.error}`).toBe(OFFLINE_TOOL_RESULT);
  });
});
