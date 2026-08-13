/**
 * t-8e0366 — exact catalog for the two families that register only under a dep/setting.
 * Presence loops on a handwritten list catch a removed name and miss an added one.
 * registerTools is the door Bridge.createMcp uses; the lists themselves stay handwritten.
 */
import { describe, expect, it } from "vitest";
import { registerTools } from "../../src/bridge/tools.js";
import type { BridgeDeps } from "../../src/bridge/tools/shared.js";
import {
  CANONICAL_BRIDGE_TOOL_COUNT,
  IDE_BROWSER_TOOL_NAMES,
  USER_BROWSER_TOOL_NAMES,
} from "../helpers/bridgeConditionalToolNames.js";

class ToolCapture {
  names: string[] = [];
  registerTool(name: string) {
    this.names.push(name);
  }
}

function catalog(deps: Partial<BridgeDeps> = {}): string[] {
  const mcp = new ToolCapture();
  registerTools(mcp as never, {
    workspaceRoot: "/tmp/t-8e0366-catalog",
    caller: { kind: "agent", name: "inventory" },
    ...deps,
  } as BridgeDeps);
  return [...mcp.names].sort();
}

const ide = (names: string[]) => names.filter((n) => n.startsWith("ide_browser_"));
const user = (names: string[]) => names.filter((n) => n.startsWith("user_browser_"));

describe("t-8e0366 — conditional Bridge families are exact, not merely present", () => {
  it("canonical (no optional deps) exposes neither family", () => {
    const names = catalog();
    expect(names).toHaveLength(CANONICAL_BRIDGE_TOOL_COUNT);
    expect(ide(names)).toEqual([]);
    expect(user(names)).toEqual([]);
  });

  it("ideBrowserRequest wired exposes exactly the handwritten ide_browser_* list", () => {
    const names = catalog({
      ideBrowserRequest: async () => ({ ok: false, error: "offline" }),
    });
    expect(ide(names)).toEqual([...IDE_BROWSER_TOOL_NAMES].sort());
    expect(user(names)).toEqual([]);
    expect(names).toHaveLength(CANONICAL_BRIDGE_TOOL_COUNT + IDE_BROWSER_TOOL_NAMES.length);
  });

  it("tabTools on exposes exactly the handwritten user_browser_* list", () => {
    const names = catalog({ companionTabToolsEnabled: () => true });
    expect(user(names)).toEqual([...USER_BROWSER_TOOL_NAMES].sort());
    expect(ide(names)).toEqual([]);
    expect(names).toHaveLength(CANONICAL_BRIDGE_TOOL_COUNT + USER_BROWSER_TOOL_NAMES.length);
  });

  it("both families on is canonical plus both handwritten lists", () => {
    const names = catalog({
      ideBrowserRequest: async () => ({ ok: false, error: "offline" }),
      companionTabToolsEnabled: () => true,
    });
    expect(ide(names)).toEqual([...IDE_BROWSER_TOOL_NAMES].sort());
    expect(user(names)).toEqual([...USER_BROWSER_TOOL_NAMES].sort());
    expect(names).toHaveLength(
      CANONICAL_BRIDGE_TOOL_COUNT + IDE_BROWSER_TOOL_NAMES.length + USER_BROWSER_TOOL_NAMES.length,
    );
  });
});
