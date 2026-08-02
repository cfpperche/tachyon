import { describe, it, expect } from "vitest";
import { COCKPIT_SECTION_ORDER } from "../../src/cockpit/model.js";
import { CONTROL_SECTION_NAV } from "../../src/cockpit/sectionNav.js";

describe("CONTROL_SECTION_NAV (t-6e2952)", () => {
  it("lists exactly the twelve top-level Control sections in product order", () => {
    expect(CONTROL_SECTION_NAV.map((t) => t.id)).toEqual([...COCKPIT_SECTION_ORDER]);
    expect(CONTROL_SECTION_NAV).toHaveLength(12);
  });

  it("carries a codicon + non-empty label for every tile", () => {
    for (const tile of CONTROL_SECTION_NAV) {
      expect(tile.icon.length).toBeGreaterThan(0);
      expect(tile.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("matches the product names the task names (Board/Execution/Runtime Ops)", () => {
    const byId = Object.fromEntries(CONTROL_SECTION_NAV.map((t) => [t.id, t.label]));
    expect(byId.overview).toBe("Overview");
    expect(byId.mission).toBe("Board");
    expect(byId["execution-graph"]).toBe("Execution");
    expect(byId.runtime).toBe("Runtime Ops");
    expect(byId["runtime-config"]).toBe("Runtime Config");
    expect(byId.tmux).toBe("tmux");
  });
});
