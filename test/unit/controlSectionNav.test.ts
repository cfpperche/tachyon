import { describe, it, expect } from "vitest";
import { COCKPIT_SECTION_ORDER } from "@tachyon/webview-ui/sections/model";
import { CONTROL_SECTION_NAV } from "../../packages/webview-ui/src/webview/sidebar/sectionNav.js";

describe("CONTROL_SECTION_NAV (t-6e2952)", () => {
  it("lists nine top-level tiles, covering every section Control renders", () => {
    // SDD 485 C5 — the launcher is no longer a projection of COCKPIT_SECTION_ORDER: it lists what a human
    // can OPEN, and one of them (the Board) now opens a standalone app instead of navigating Control.
    // The containment direction is what must hold — a section Control renders with no tile is unreachable.
    //
    // t-5f2b5b — twelve became ELEVEN: the Fleet tile was deleted by owner decision (2026-08-07), because
    // the app behind it was deleted and the sidebar Agents tab is the only fleet. The count is not the
    // claim; the two containment/order assertions below are, and they are unchanged.
    //
    // SDD 500 — and ten became NINE, this time because two tiles MERGED rather than one being deleted:
    // Overview and Engine are one screen called System. Same shape either way — the ids stay decodable
    // and only the launcher shrinks.
    expect(CONTROL_SECTION_NAV).toHaveLength(9);
    const tiles = CONTROL_SECTION_NAV.map((t) => t.id);
    for (const id of COCKPIT_SECTION_ORDER) expect(tiles, `section '${id}' has no launcher tile`).toContain(id);
    // t-5f2b5b — and the deletion is pinned, not merely reflected in a number: `fleet` is STILL a
    // SectionId (parent of agent-activity/agent-probes and of five studios, so it must keep
    // decoding), which is exactly what would let a tile for it drift back in unnoticed.
    expect(tiles, "the Fleet tile was deleted — it must not come back").not.toContain("fleet");
    // SDD 500 — the same guard for the merged pair, and for the same reason: both are STILL
    // CockpitSectionIds (route.ts's eight defaults name `overview` at the call site), which is exactly
    // what would let a tile for either drift back in beside the System tile that replaced them.
    for (const merged of ["overview", "engine"]) {
      expect(tiles, `the ${merged} tile was merged into System — it must not come back`).not.toContain(merged);
    }
    // and the order the sections DO share is unchanged — a tile did not move, one changed destination.
    expect(tiles.filter((id) => COCKPIT_SECTION_ORDER.includes(id))).toEqual([...COCKPIT_SECTION_ORDER]);
  });

  it("marks exactly the standalone-app tiles, and only those (SDD 485)", () => {
    const standalone = CONTROL_SECTION_NAV.filter((t) => t.standalone).map((t) => t.id);
    // in LAUNCHER_ORDER, which is why `runtime` lands between `mission` and `tmux` rather than at the end:
    // a migration changes a tile's destination and never its position (SDD 485 D4 is the fifth to prove
    // it: `inbox` leads this list because its tile sits fourth in LAUNCHER_ORDER, exactly where it was).
    expect(standalone).toEqual(CONTROL_SECTION_NAV.map((tile) => tile.id));
    // the flag and the section list are two statements of one fact; they must not disagree.
    for (const id of standalone) expect(COCKPIT_SECTION_ORDER).not.toContain(id);
  });

  it("carries a codicon + non-empty label for every tile", () => {
    for (const tile of CONTROL_SECTION_NAV) {
      expect(tile.icon.length).toBeGreaterThan(0);
      expect(tile.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("matches the product names the task names (Board/Runtime Ops)", () => {
    const byId = Object.fromEntries(CONTROL_SECTION_NAV.map((t) => [t.id, t.label]));
    expect(byId.system).toBe("System");
    expect(byId.mission).toBe("Board");
    expect(byId.runtime).toBe("Runtime Ops");
    expect(byId["runtime-config"]).toBe("Runtime Config");
    expect(byId.tmux).toBe("tmux");
  });
});
