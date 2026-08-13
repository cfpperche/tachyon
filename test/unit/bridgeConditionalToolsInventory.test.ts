/**
 * t-8e0366 — exact catalog for the two families that register only under a dep/setting.
 * Presence loops on a handwritten list catch a removed name and miss an added one.
 * registerTools is the door Bridge.createMcp uses; the lists themselves stay handwritten.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { registerTools } from "../../src/bridge/tools.js";
import type { BridgeDeps } from "../../src/bridge/tools/shared.js";
import {
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
// t-8e0366 / t-33b5cd — identity of the off-catalog remainder, not a count of it.
// A toHaveLength(80) is a second address when a base tool is added and lets two
// names swap. Comparing the filtered remainder across configs proves the families
// added nothing else and did not touch the base set.
const base = (names: string[]) => names.filter((n) => !n.startsWith("ide_browser_") && !n.startsWith("user_browser_"));

describe("t-8e0366 — conditional Bridge families are exact, not merely present", () => {
  let allOff: string[];
  let ideOn: string[];
  let userOn: string[];
  let bothOn: string[];

  beforeAll(() => {
    allOff = catalog();
    ideOn = catalog({
      ideBrowserRequest: async () => ({ ok: false, error: "offline" }),
    });
    userOn = catalog({ companionTabToolsEnabled: () => true });
    bothOn = catalog({
      ideBrowserRequest: async () => ({ ok: false, error: "offline" }),
      companionTabToolsEnabled: () => true,
    });
  });

  it("canonical (no optional deps) exposes neither family", () => {
    expect(ide(allOff)).toEqual([]);
    expect(user(allOff)).toEqual([]);
  });

  it("ideBrowserRequest wired exposes exactly the handwritten ide_browser_* list", () => {
    expect(ide(ideOn)).toEqual([...IDE_BROWSER_TOOL_NAMES].sort());
    expect(user(ideOn)).toEqual([]);
    expect(base(ideOn)).toEqual(base(allOff));
  });

  it("tabTools on exposes exactly the handwritten user_browser_* list", () => {
    expect(user(userOn)).toEqual([...USER_BROWSER_TOOL_NAMES].sort());
    expect(ide(userOn)).toEqual([]);
    expect(base(userOn)).toEqual(base(allOff));
  });

  it("both families on is the same base set plus both handwritten lists", () => {
    expect(ide(bothOn)).toEqual([...IDE_BROWSER_TOOL_NAMES].sort());
    expect(user(bothOn)).toEqual([...USER_BROWSER_TOOL_NAMES].sort());
    expect(base(bothOn)).toEqual(base(allOff));
  });
});
