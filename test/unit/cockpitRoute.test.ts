import { describe, it, expect } from "vitest";
import {
  routes,
  routeKey,
  parentRoute,
  refreshPolicy,
  formatRoute,
  decodeRoute,
  decodePanelState,
  type CockpitRoute,
} from "../../src/cockpit/route.js";
import { COCKPIT_SECTION_ORDER } from "../../src/cockpit/model.js";

describe("routes.section / routeKey / formatRoute", () => {
  it("builds a section route and derives its key + display string", () => {
    const r = routes.section("mission");
    expect(r).toEqual({ kind: "section", section: "mission" });
    expect(routeKey(r)).toBe("section:mission");
    expect(formatRoute(r)).toBe("mission");
  });
});

describe("parentRoute", () => {
  it("every section route is top-level (no parent)", () => {
    for (const section of COCKPIT_SECTION_ORDER) {
      expect(parentRoute(routes.section(section))).toBeNull();
    }
  });
});

describe("refreshPolicy", () => {
  it("every section route polls today (matches current behavior exactly)", () => {
    for (const section of COCKPIT_SECTION_ORDER) {
      expect(refreshPolicy(routes.section(section))).toBe("poll");
    }
  });
});

describe("decodeRoute (the one trust-boundary decoder)", () => {
  it("accepts a well-formed section route for every known section id", () => {
    for (const section of COCKPIT_SECTION_ORDER) {
      expect(decodeRoute({ kind: "section", section })).toEqual({ kind: "section", section });
    }
  });

  it("rejects a non-object, null, or array", () => {
    expect(decodeRoute(null)).toBeNull();
    expect(decodeRoute(undefined)).toBeNull();
    expect(decodeRoute("section:mission")).toBeNull();
    expect(decodeRoute(42)).toBeNull();
    expect(decodeRoute([])).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(decodeRoute({ kind: "task-detail", id: "t-abc123" })).toBeNull();
    expect(decodeRoute({ kind: "bogus", section: "mission" })).toBeNull();
  });

  it("rejects an invalid section id", () => {
    expect(decodeRoute({ kind: "section", section: "not-a-real-section" })).toBeNull();
    expect(decodeRoute({ kind: "section", section: "" })).toBeNull();
    expect(decodeRoute({ kind: "section", section: 42 })).toBeNull();
  });

  it("rejects extra/unknown fields — a route is never a loose bag of properties", () => {
    expect(decodeRoute({ kind: "section", section: "mission", extra: "nope" })).toBeNull();
    expect(decodeRoute({ kind: "section", section: "mission", params: { id: "t-1" } })).toBeNull();
  });

  it("rejects a missing section field", () => {
    expect(decodeRoute({ kind: "section" })).toBeNull();
  });
});

describe("decodePanelState (persisted-state restore boundary)", () => {
  it("decodes a valid v2 record", () => {
    const state = { schemaVersion: 2, view: "tachyonCockpit", route: { kind: "section", section: "fleet" }, wsHash: "abc123" };
    expect(decodePanelState(state)).toEqual({ route: { kind: "section", section: "fleet" }, wsHash: "abc123" });
  });

  it("decodes a v1 record's bare section field", () => {
    const state = { schemaVersion: 1, view: "tachyonCockpit", section: "worktrees", wsHash: "def456" };
    expect(decodePanelState(state)).toEqual({ route: { kind: "section", section: "worktrees" }, wsHash: "def456" });
  });

  it("falls back to overview for a v1 record with no section", () => {
    const state = { schemaVersion: 1, view: "tachyonCockpit" };
    expect(decodePanelState(state)).toEqual({ route: { kind: "section", section: "overview" } });
  });

  it("falls back to overview for a v2 record whose route fails decode (never trusts a malformed route)", () => {
    const state = { schemaVersion: 2, view: "tachyonCockpit", route: { kind: "section", section: "not-real" } };
    expect(decodePanelState(state)).toEqual({ route: { kind: "section", section: "overview" } });
  });

  it("falls back to overview for null/undefined/garbage input", () => {
    expect(decodePanelState(undefined)).toEqual({ route: { kind: "section", section: "overview" } });
    expect(decodePanelState(null)).toEqual({ route: { kind: "section", section: "overview" } });
    expect(decodePanelState("garbage")).toEqual({ route: { kind: "section", section: "overview" } });
    expect(decodePanelState({})).toEqual({ route: { kind: "section", section: "overview" } });
  });

  it("carries wsHash through even on a fallback decode", () => {
    const state = { schemaVersion: 2, view: "tachyonCockpit", route: { kind: "bogus" }, wsHash: "keep-me" };
    expect(decodePanelState(state)).toEqual({ route: { kind: "section", section: "overview" }, wsHash: "keep-me" });
  });
});

describe("exhaustiveness seam (route.ts's core promise, not yet load-bearing)", () => {
  it("every CockpitRoute kind literal is handled by routeKey/parentRoute/refreshPolicy/formatRoute", () => {
    // Only one kind exists today, so these are straight-line functions, not a real exhaustive
    // switch — see route.ts's comment above each. The FIRST time C.1 adds a second kind, convert
    // to switch + `default: assertNever(route)` so a missed case fails `npx tsc`, not this test.
    const r: CockpitRoute = routes.section("overview");
    expect(() => routeKey(r)).not.toThrow();
    expect(() => parentRoute(r)).not.toThrow();
    expect(() => refreshPolicy(r)).not.toThrow();
    expect(() => formatRoute(r)).not.toThrow();
  });
});
