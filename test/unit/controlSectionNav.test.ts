import { describe, it, expect } from "vitest";
import { COCKPIT_SECTION_ORDER } from "../../src/cockpit/model.js";
import { CONTROL_SECTION_NAV } from "../../src/cockpit/sectionNav.js";

describe("CONTROL_SECTION_NAV (t-6e2952)", () => {
  it("lists twelve top-level tiles, covering every section Control renders", () => {
    // SDD 485 C5 — the launcher is no longer a projection of COCKPIT_SECTION_ORDER: it lists what a human
    // can OPEN, and one of the twelve (the Board) now opens a standalone app instead of navigating Control.
    // The containment direction is what must hold — a section Control renders with no tile is unreachable.
    expect(CONTROL_SECTION_NAV).toHaveLength(12);
    const tiles = CONTROL_SECTION_NAV.map((t) => t.id);
    for (const id of COCKPIT_SECTION_ORDER) expect(tiles, `section '${id}' has no launcher tile`).toContain(id);
    // and the order the sections DO share is unchanged — a tile did not move, one changed destination.
    expect(tiles.filter((id) => COCKPIT_SECTION_ORDER.includes(id))).toEqual([...COCKPIT_SECTION_ORDER]);
  });

  it("marks exactly the standalone-app tiles, and only those (SDD 485)", () => {
    const standalone = CONTROL_SECTION_NAV.filter((t) => t.standalone).map((t) => t.id);
    expect(standalone).toEqual(["mission", "tmux", "plugins"]);
    // the flag and the section list are two statements of one fact; they must not disagree.
    for (const id of standalone) expect(COCKPIT_SECTION_ORDER).not.toContain(id);
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
