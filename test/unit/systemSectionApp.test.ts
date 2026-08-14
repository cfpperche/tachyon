import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COCKPIT_SECTION_IDS, collectNeedsFor, type SectionId } from "@tachyon/webview-ui/sections/model";
import { resolveSectionDestination } from "../../src/sections/route";
import { isSectionId, resolveSection } from "../../src/sections/resolveSection.js";
import { CONTROL_SECTION_NAV } from "../../packages/webview-ui/src/webview/sidebar/sectionNav.js";
import { WEBVIEW_APPS } from "../../src/webview/webviewApps.js";
import { WEBVIEW_SURFACES } from "../../src/webview/surfaces.js";

/**
 * SDD 500 S1 — `system` is the destination; `overview` and `engine` keep decoding and resolve to it.
 *
 * The precedent this applies is `fleet` (`sectionNav.ts`'s own comment): an id may leave the launcher
 * while staying a `SectionId`, because something else still has to be able to READ it. Here the
 * "something else" is `route.ts`'s eight default fallbacks, which name `"overview"` at the call site by
 * a documented decision — so the id must not stop decoding, and this file is what pins that.
 */
describe("SDD 500 S1 — overview and engine resolve to system", () => {
  it("system is a section id, and so are the two ids it replaces", () => {
    for (const id of ["system", "overview", "engine"] satisfies SectionId[]) {
      expect(isSectionId(id), `'${id}' must still decode`).toBe(true);
      expect(COCKPIT_SECTION_IDS).toContain(id);
    }
  });

  it("both old ids resolve to system, and every other id resolves to itself", () => {
    expect(resolveSectionDestination("overview")).toBe("system");
    expect(resolveSectionDestination("engine")).toBe("system");
    for (const id of COCKPIT_SECTION_IDS) {
      if (id === "overview" || id === "engine") continue;
      expect(resolveSectionDestination(id), `'${id}' must not be aliased`).toBe(id);
    }
    // the alias is idempotent — a destination is already a destination.
    expect(resolveSectionDestination(resolveSectionDestination("overview"))).toBe("system");
  });

  it("an unknown or retired id still lands on a section that exists", () => {
    // spec.md § "the default route survives": the resolver's own fallback is `overview`, which is now an
    // ALIAS rather than a destination — so the two functions have to compose to something renderable.
    expect(resolveSectionDestination(resolveSection("nope"))).toBe("system");
    expect(resolveSectionDestination(resolveSection(undefined))).toBe("system");
    // `fleet` has no tile and no app (t-5f2b5b) and is not aliased; it falls through to the caller's
    // default, which is the same `overview` -> `system` path.
    expect(resolveSectionDestination("fleet")).toBe("fleet");
  });

  it("route.ts's eight default fallbacks are untouched — they still name overview", () => {
    // The whole argument of plan.md § D1: because `overview` keeps decoding, not one of these has to
    // change. If a future edit rewrites them to `system`, that is a different decision and this goes red.
    const route = readFileSync("src/sections/route.ts", "utf8");
    const fallbacks = [...route.matchAll(/section:\s*"overview"/g)].length;
    expect(fallbacks, "the three parentRoute overview fallbacks moved or were rewritten").toBe(3);
    expect(route).toContain('routes.section("overview")');
    expect(route).toContain('coercing null to "overview" inside this function');
    expect(route).toContain("defaulting to overview");
  });

  it("the launcher offers one System tile and neither of the two it replaces", () => {
    const tiles = CONTROL_SECTION_NAV.map((t) => t.id);
    expect(tiles).toContain("system");
    expect(tiles, "the Overview tile is replaced, not kept").not.toContain("overview");
    expect(tiles, "the Engine tile is replaced, not kept").not.toContain("engine");
  });

  it("the System app is the only surface behind those ids", () => {
    const views = WEBVIEW_APPS.map((a) => a.view);
    expect(views).toContain("system");
    expect(views).not.toContain("overview");
    expect(views).not.toContain("engine");
    const ids = WEBVIEW_SURFACES.map((s) => s.viewId);
    expect(ids).toContain("tachyonSystem");
    expect(ids, "a retired viewId must not keep a manifest row").not.toContain("tachyonOverview");
    expect(ids).not.toContain("tachyonEngine");
  });

  it("the section that reads worktrees is the one that renders them", () => {
    // Overview's counter was the reason `overview` was on this list; System carries that counter now,
    // and a section that never asks for the slice reports a confident zero (`worktreesCollected`).
    expect(collectNeedsFor("system").worktrees).toBe(true);
  });
});
