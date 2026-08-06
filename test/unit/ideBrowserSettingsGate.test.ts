/**
 * SDD 488 F4 / t-48ff4a — settings.ideBrowser.enabled is a human + call-time gate only.
 * Registration always follows ideBrowserRequest wiring (see ideBrowserToolsOffline.test.ts).
 */
import { describe, expect, it } from "vitest";
import { registerIdeBrowserTools } from "../../src/bridge/tools/ide-browser.js";
import type { BridgeDeps } from "../../src/bridge/tools/shared.js";
import {
  IDE_BROWSER_DISABLED_CODE,
  IDE_BROWSER_DISABLED_ERROR,
  IDE_BROWSER_FIRST_USE_TIPS,
  isIdeBrowserEnabled,
} from "../../src/ide-browser/settings.js";

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
    workspaceRoot: "/tmp/tachyon-ide-browser-settings-gate",
    ...deps,
  } as BridgeDeps);
  return mcp;
}

describe("isIdeBrowserEnabled", () => {
  it("is opt-in: only explicit true enables", () => {
    expect(isIdeBrowserEnabled(undefined)).toBe(false);
    expect(isIdeBrowserEnabled({})).toBe(false);
    expect(isIdeBrowserEnabled({ ideBrowser: {} })).toBe(false);
    expect(isIdeBrowserEnabled({ ideBrowser: { enabled: false } })).toBe(false);
    expect(isIdeBrowserEnabled({ ideBrowser: { enabled: true } })).toBe(true);
  });
});

describe("t-48ff4a — disabled fails at call time; tools still register", () => {
  it("registers all tools when ideBrowserRequest is wired even if the feature is disabled", () => {
    const mcp = wire({
      ideBrowserRequest: async () => ({
        ok: false,
        code: IDE_BROWSER_DISABLED_CODE,
        error: IDE_BROWSER_DISABLED_ERROR,
      }),
    });
    for (const name of IDE_BROWSER_TOOL_NAMES) {
      expect(mcp.handlers.has(name), `expected ${name} registered while disabled`).toBe(true);
    }
  });

  it("call-time disabled envelope is actionable and distinct from offline", async () => {
    const mcp = wire({
      ideBrowserRequest: async () => ({
        ok: false,
        code: IDE_BROWSER_DISABLED_CODE,
        error: IDE_BROWSER_DISABLED_ERROR,
      }),
    });
    const handler = mcp.handlers.get("ide_browser_status");
    expect(handler).toBeDefined();
    const result = await handler!({});
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain(IDE_BROWSER_DISABLED_ERROR);
    expect(text).toMatch(/settings\.ideBrowser\.enabled/);
    expect(text).not.toMatch(/bridge offline/i);
  });
});

describe("first-use onboarding copy", () => {
  it("ships procedural tips for the first open", () => {
    expect(IDE_BROWSER_FIRST_USE_TIPS).toMatch(/globe/i);
    expect(IDE_BROWSER_FIRST_USE_TIPS).toMatch(/Design Mode/i);
    expect(IDE_BROWSER_FIRST_USE_TIPS).toMatch(/homeUrl/);
  });
});
