import { describe, it, expect } from "vitest";
import {
  routes,
  routeKey,
  parentRoute,
  navSection,
  refreshPolicy,
  formatRoute,
  decodeRoute,
  decodePanelState,
  isStudioRoute,
  type CockpitRoute,
} from "../../src/cockpit/route.js";
import { COCKPIT_SECTION_ORDER } from "../../src/cockpit/model.js";
import { STUDIO_IDS } from "../../src/cockpit/studioIds.js";

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

// t-610705 (Phase D, D2) — "task" is the one StudioId whose "new" session is never actually
// id-less (every real caller pre-mints and opens studio-edit directly — route.ts's decodeRoute
// rejects studio-new+task outright, and routes.studioNew("task",...) throws defensively). The
// generic per-StudioId loops below therefore exclude "task" from the studio-new half and cover it
// separately, in its own dedicated block, using the raw route object (still a valid CockpitRoute
// literal — only the trust-boundary decoder and the factory function refuse to construct one).
const NON_TASK_STUDIO_IDS = STUDIO_IDS.filter((s) => s !== "task");

describe("studio-new / studio-edit (t-610705 Phase D, D0)", () => {
  it("builds routes, derives keys, and formats a display string per StudioId", () => {
    for (const studio of NON_TASK_STUDIO_IDS) {
      const fresh = routes.studioNew(studio, "ws-1");
      expect(fresh).toEqual({ kind: "studio-new", studio, wsHash: "ws-1" });
      expect(routeKey(fresh)).toBe(`studio-new:${studio}:ws-1`);
      expect(formatRoute(fresh)).toBe(`${studio} new`);

      const edit = routes.studioEdit(studio, "ws-1", "cmd-a");
      expect(edit).toEqual({ kind: "studio-edit", studio, wsHash: "ws-1", entityId: "cmd-a" });
      expect(routeKey(edit)).toBe(`studio-edit:${studio}:ws-1:cmd-a`);
      expect(formatRoute(edit)).toBe(`${studio} cmd-a`);
    }
  });

  it("every non-task StudioId's parent/nav is the fleet section for both new and edit (t-610705 Phase D, D1a)", () => {
    for (const studio of NON_TASK_STUDIO_IDS) {
      expect(parentRoute(routes.studioNew(studio, "ws-1"))).toEqual({ kind: "section", section: "fleet" });
      expect(parentRoute(routes.studioEdit(studio, "ws-1", "cmd-a"))).toEqual({ kind: "section", section: "fleet" });
      expect(navSection(routes.studioNew(studio, "ws-1"))).toBe("fleet");
      expect(navSection(routes.studioEdit(studio, "ws-1", "cmd-a"))).toBe("fleet");
    }
  });

  it("task's parent/nav: new falls back to mission (unreachable in practice), edit goes to the specific task-detail subroute (t-610705 Phase D, D2)", () => {
    const fresh: CockpitRoute = { kind: "studio-new", studio: "task", wsHash: "ws-1" };
    expect(parentRoute(fresh)).toEqual({ kind: "section", section: "mission" });
    expect(navSection(fresh)).toBe("mission");

    const edit = routes.studioEdit("task", "ws-1", "t-abc123");
    expect(parentRoute(edit)).toEqual({ kind: "task-detail", wsHash: "ws-1", taskId: "t-abc123" });
    expect(navSection(edit)).toBe("mission");
  });

  it("routes.studioNew refuses to construct a task route — every real 'new task' caller pre-mints an id and opens studio-edit directly", () => {
    expect(() => routes.studioNew("task", "ws-1")).toThrow(/task is never id-less/);
  });

  it("never polls on the shared shell timer — a form must not be clobbered mid-edit", () => {
    for (const studio of NON_TASK_STUDIO_IDS) {
      expect(refreshPolicy(routes.studioNew(studio, "ws-1"))).toBe("none");
      expect(refreshPolicy(routes.studioEdit(studio, "ws-1", "cmd-a"))).toBe("none");
    }
    expect(refreshPolicy({ kind: "studio-new", studio: "task", wsHash: "ws-1" })).toBe("none");
    expect(refreshPolicy(routes.studioEdit("task", "ws-1", "t-abc123"))).toBe("none");
  });

  it("isStudioRoute is true for both kinds and false for everything else", () => {
    expect(isStudioRoute(routes.studioNew("command", "ws-1"))).toBe(true);
    expect(isStudioRoute(routes.studioEdit("command", "ws-1", "cmd-a"))).toBe(true);
    expect(isStudioRoute(routes.section("fleet"))).toBe(false);
    expect(isStudioRoute(routes.taskDetail("ws-1", "t-1"))).toBe(false);
  });

  it("decodeRoute round-trips a valid studio-new/studio-edit route", () => {
    expect(decodeRoute({ kind: "studio-new", studio: "command", wsHash: "ws-1" })).toEqual({ kind: "studio-new", studio: "command", wsHash: "ws-1" });
    expect(decodeRoute({ kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "cmd-a" })).toEqual({ kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "cmd-a" });
  });

  it("decodeRoute rejects an unknown studio, missing fields, or extra fields", () => {
    expect(decodeRoute({ kind: "studio-new", studio: "bogus", wsHash: "ws-1" })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", studio: "command" })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", wsHash: "ws-1" })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", studio: "command", wsHash: "" })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", studio: "command", wsHash: "ws-1", extra: 1 })).toBeNull();
    expect(decodeRoute({ kind: "studio-edit", studio: "command", wsHash: "ws-1" })).toBeNull();
    expect(decodeRoute({ kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "" })).toBeNull();
  });

  it("decodeRoute rejects studio-new for task (t-610705, D2) — never id-less, even though 'task' is otherwise a well-formed StudioId", () => {
    expect(decodeRoute({ kind: "studio-new", studio: "task", wsHash: "ws-1" })).toBeNull();
    // studio-edit for task is unaffected — a real, addressable in-progress edit is exactly the supported shape.
    expect(decodeRoute({ kind: "studio-edit", studio: "task", wsHash: "ws-1", entityId: "t-abc123" })).toEqual({ kind: "studio-edit", studio: "task", wsHash: "ws-1", entityId: "t-abc123" });
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
