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
  type ProductRoute,
  type CockpitNonStudioRoute,
} from "../../src/sections/route.js";
import { COCKPIT_SECTION_ORDER } from "../../src/sections/model.js";
import { resolveCockpitSection } from "../../src/sections/resolveSection.js";
import { STUDIO_IDS } from "../../src/webview/shared/studio/studioIds.js";

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

describe("retired per-kind navigation compatibility", () => {
  it("keeps Approvals and Validations as deep-link targets without top-level tabs", () => {
    expect(COCKPIT_SECTION_ORDER).not.toContain("approvals");
    expect(COCKPIT_SECTION_ORDER).not.toContain("validations");
    expect(resolveCockpitSection("approvals")).toBe("approvals");
    expect(resolveCockpitSection("validations")).toBe("validations");
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

// t-610705 (Phase D, D2/D3) — "task" is the one StudioId whose "new" session is never actually
// id-less (every real caller pre-mints and opens studio-edit directly — route.ts's decodeRoute
// rejects studio-new+task outright, and routes.studioNew("task",...) throws defensively). "pin" is
// the one StudioId whose parent/nav is NOT the static "fleet" answer (nav-less — its own returnRoute
// slot instead, D3). The generic per-StudioId loops below therefore exclude both, each covered
// separately in its own dedicated block.
const NON_TASK_STUDIO_IDS = STUDIO_IDS.filter((s) => s !== "task");
const GENERIC_FLEET_STUDIO_IDS = STUDIO_IDS.filter((s) => s !== "task" && s !== "pin");

describe("studio-new / studio-edit (t-610705 Phase D, D0)", () => {
  it("builds routes, derives keys, and formats a display string per StudioId", () => {
    for (const studio of NON_TASK_STUDIO_IDS) {
      const fresh = routes.studioNew(studio, "ws-1");
      expect(fresh).toEqual({ kind: "studio-new", studio, wsHash: "ws-1", returnRoute: null });
      expect(routeKey(fresh)).toBe(`studio-new:${studio}:ws-1`);
      expect(formatRoute(fresh)).toBe(`${studio} new`);

      const edit = routes.studioEdit(studio, "ws-1", "cmd-a");
      expect(edit).toEqual({ kind: "studio-edit", studio, wsHash: "ws-1", entityId: "cmd-a", returnRoute: null });
      expect(routeKey(edit)).toBe(`studio-edit:${studio}:ws-1:cmd-a`);
      expect(formatRoute(edit)).toBe(`${studio} cmd-a`);
    }
  });

  it("every fleet-parented StudioId's parent/nav is the fleet section for both new and edit (t-610705 Phase D, D1a)", () => {
    for (const studio of GENERIC_FLEET_STUDIO_IDS) {
      expect(parentRoute(routes.studioNew(studio, "ws-1"))).toEqual({ kind: "section", section: "fleet" });
      expect(parentRoute(routes.studioEdit(studio, "ws-1", "cmd-a"))).toEqual({ kind: "section", section: "fleet" });
      expect(navSection(routes.studioNew(studio, "ws-1"))).toBe("fleet");
      expect(navSection(routes.studioEdit(studio, "ws-1", "cmd-a"))).toBe("fleet");
    }
  });

  it("task's parent/nav: new falls back to mission (unreachable in practice), edit goes to the specific task-detail subroute (t-610705 Phase D, D2)", () => {
    const fresh: ProductRoute = { kind: "studio-new", studio: "task", wsHash: "ws-1", returnRoute: null };
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
    expect(refreshPolicy({ kind: "studio-new", studio: "task", wsHash: "ws-1", returnRoute: null })).toBe("none");
    expect(refreshPolicy(routes.studioEdit("task", "ws-1", "t-abc123"))).toBe("none");
  });

  it("isStudioRoute is true for both kinds and false for everything else", () => {
    expect(isStudioRoute(routes.studioNew("command", "ws-1"))).toBe(true);
    expect(isStudioRoute(routes.studioEdit("command", "ws-1", "cmd-a"))).toBe(true);
    expect(isStudioRoute(routes.section("fleet"))).toBe(false);
    expect(isStudioRoute(routes.taskDetail("ws-1", "t-1"))).toBe(false);
  });

  it("decodeRoute round-trips a valid studio-new/studio-edit route", () => {
    expect(decodeRoute({ kind: "studio-new", studio: "command", wsHash: "ws-1", returnRoute: null }))
      .toEqual({ kind: "studio-new", studio: "command", wsHash: "ws-1", returnRoute: null });
    expect(decodeRoute({ kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "cmd-a", returnRoute: null }))
      .toEqual({ kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "cmd-a", returnRoute: null });
  });

  it("decodeRoute rejects an unknown studio, missing fields, or extra fields", () => {
    expect(decodeRoute({ kind: "studio-new", studio: "bogus", wsHash: "ws-1", returnRoute: null })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", studio: "command", returnRoute: null })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", wsHash: "ws-1", returnRoute: null })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", studio: "command", wsHash: "", returnRoute: null })).toBeNull();
    expect(decodeRoute({ kind: "studio-new", studio: "command", wsHash: "ws-1", returnRoute: null, extra: 1 })).toBeNull();
    expect(decodeRoute({ kind: "studio-edit", studio: "command", wsHash: "ws-1", returnRoute: null })).toBeNull();
    expect(decodeRoute({ kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "", returnRoute: null })).toBeNull();
    // t-610705 (Phase D, D3) — returnRoute is a MANDATORY key now (same "no optional fields" rule the
    // rest of this route shape already enforces) — a record from before D3 simply lacking the key
    // fails closed rather than being silently treated as returnRoute:null.
    expect(decodeRoute({ kind: "studio-new", studio: "command", wsHash: "ws-1" })).toBeNull();
    expect(decodeRoute({ kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "cmd-a" })).toBeNull();
  });

  it("decodeRoute rejects studio-new for task (t-610705, D2) — never id-less, even though 'task' is otherwise a well-formed StudioId", () => {
    expect(decodeRoute({ kind: "studio-new", studio: "task", wsHash: "ws-1", returnRoute: null })).toBeNull();
    // studio-edit for task is unaffected — a real, addressable in-progress edit is exactly the supported shape.
    expect(decodeRoute({ kind: "studio-edit", studio: "task", wsHash: "ws-1", entityId: "t-abc123", returnRoute: null }))
      .toEqual({ kind: "studio-edit", studio: "task", wsHash: "ws-1", entityId: "t-abc123", returnRoute: null });
  });
});

// t-610705 (Phase D, D3) — pin is nav-less: its parent/nav come from its OWN captured `returnRoute`
// slot, never a static per-StudioId table (studios-routes-design.md). Design hardened via an
// adversarial dueto (probe-43bca1cc) before implementation — these cases cover its findings directly:
// the pin-only invariant enforced at decode time, non-null returnRoute rejected for every OTHER
// studio, workspace-mismatch rejected on a nested wsHash-bearing returnRoute, and routeKey excluding
// returnRoute from identity.
describe("pin's nav-less returnRoute (t-610705 Phase D, D3)", () => {
  it("routes.studioNew/studioEdit accept an explicit returnRoute", () => {
    const back: CockpitNonStudioRoute = { kind: "section", section: "mission" };
    expect(routes.studioNew("pin", "ws-1", back)).toEqual({ kind: "studio-new", studio: "pin", wsHash: "ws-1", returnRoute: back });
    expect(routes.studioEdit("pin", "ws-1", "p-1", back)).toEqual({ kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1", returnRoute: back });
  });

  it("parentRoute/navSection fall back to Overview when returnRoute was never captured (null)", () => {
    const fresh = routes.studioNew("pin", "ws-1");
    expect(parentRoute(fresh)).toEqual({ kind: "section", section: "overview" });
    expect(navSection(fresh)).toBeNull();
    const edit = routes.studioEdit("pin", "ws-1", "p-1");
    expect(parentRoute(edit)).toEqual({ kind: "section", section: "overview" });
    expect(navSection(edit)).toBeNull();
  });

  it("parentRoute reads the captured returnRoute directly, for every non-studio route kind", () => {
    const cases: CockpitNonStudioRoute[] = [
      { kind: "section", section: "mission" },
      { kind: "task-detail", wsHash: "ws-1", taskId: "t-abc123" },
      { kind: "agent-activity", wsHash: "ws-1", agent: "claude" },
      { kind: "agent-probes", wsHash: "ws-1", agent: "claude" },
      { kind: "workspace-probes", wsHash: "ws-1" },
    ];
    for (const back of cases) {
      const edit = routes.studioEdit("pin", "ws-1", "p-1", back);
      expect(parentRoute(edit)).toEqual(back);
    }
  });

  it("routeKey excludes returnRoute — re-opening the same pin from a different origin is still the same identity", () => {
    const a = routes.studioEdit("pin", "ws-1", "p-1", { kind: "section", section: "mission" });
    const b = routes.studioEdit("pin", "ws-1", "p-1", { kind: "section", section: "fleet" });
    expect(routeKey(a)).toBe(routeKey(b));
  });

  it("decodeRoute accepts a valid nested returnRoute for pin only", () => {
    const decoded = decodeRoute({
      kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1",
      returnRoute: { kind: "section", section: "mission" },
    });
    expect(decoded).toEqual({ kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1", returnRoute: { kind: "section", section: "mission" } });
  });

  it("decodeRoute rejects a non-null returnRoute for every studio EXCEPT pin", () => {
    for (const studio of STUDIO_IDS.filter((s) => s !== "pin" && s !== "task")) {
      expect(decodeRoute({
        kind: "studio-edit", studio, wsHash: "ws-1", entityId: "x-1",
        returnRoute: { kind: "section", section: "mission" },
      })).toBeNull();
    }
  });

  it("decodeRoute rejects a returnRoute that itself decodes to a studio kind (excluded by construction)", () => {
    expect(decodeRoute({
      kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1",
      returnRoute: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "cmd-a", returnRoute: null },
    })).toBeNull();
  });

  it("decodeRoute rejects a returnRoute whose own wsHash doesn't match the pin route's wsHash (stale/cross-workspace revive)", () => {
    expect(decodeRoute({
      kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1",
      returnRoute: { kind: "task-detail", wsHash: "ws-DIFFERENT", taskId: "t-abc123" },
    })).toBeNull();
  });

  it("routes.studioNew/studioEdit refuse a non-null returnRoute for every studio EXCEPT pin (trusted-code footgun guard, design-dueto probe-12f603f3)", () => {
    const back: CockpitNonStudioRoute = { kind: "section", section: "mission" };
    expect(() => routes.studioNew("command", "ws-1", back)).toThrow(/returnRoute is only meaningful for "pin"/);
    expect(() => routes.studioEdit("command", "ws-1", "cmd-a", back)).toThrow(/returnRoute is only meaningful for "pin"/);
    expect(() => routes.studioNew("pin", "ws-1", back)).not.toThrow();
    expect(() => routes.studioEdit("pin", "ws-1", "p-1", back)).not.toThrow();
  });

  it("decodeRoute rejects a structurally invalid returnRoute", () => {
    expect(decodeRoute({ kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1", returnRoute: "not-a-route" })).toBeNull();
    expect(decodeRoute({ kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1", returnRoute: { kind: "bogus" } })).toBeNull();
  });
});

describe("exhaustiveness seam (route.ts's core promise, not yet load-bearing)", () => {
  it("every ProductRoute kind literal is handled by routeKey/parentRoute/refreshPolicy/formatRoute", () => {
    // Only one kind exists today, so these are straight-line functions, not a real exhaustive
    // switch — see route.ts's comment above each. The FIRST time C.1 adds a second kind, convert
    // to switch + `default: assertNever(route)` so a missed case fails `npx tsc`, not this test.
    const r: ProductRoute = routes.section("overview");
    expect(() => routeKey(r)).not.toThrow();
    expect(() => parentRoute(r)).not.toThrow();
    expect(() => refreshPolicy(r)).not.toThrow();
    expect(() => formatRoute(r)).not.toThrow();
  });
});

describe("project-handoff route (t-ace77f)", () => {
  it("is not a section any more — Control has no Handoff tab", () => {
    expect(COCKPIT_SECTION_ORDER).not.toContain("handoff");
    expect(decodeRoute({ kind: "section", section: "handoff" })).toBeNull();
  });

  it("builds, keys and formats one document per workspace", () => {
    const r = routes.projectHandoff("ws-1");
    expect(r).toEqual({ kind: "project-handoff", wsHash: "ws-1" });
    expect(routeKey(r)).toBe("project-handoff:ws-1");
    expect(routeKey(routes.projectHandoff("ws-2"))).not.toBe(routeKey(r));
    expect(formatRoute(r)).toBe("project handoff");
  });

  it("leaves by breadcrumb to Overview, and lights no tab while open", () => {
    const r = routes.projectHandoff("ws-1");
    expect(parentRoute(r)).toEqual({ kind: "section", section: "overview" });
    // nav-less, like Pin Studio: "overview" here would render the Overview tab as active.
    expect(navSection(r)).toBeNull();
  });

  it("keeps polling, exactly as it did while it was a section", () => {
    expect(refreshPolicy(routes.projectHandoff("ws-1"))).toBe("poll");
  });

  it("decodes only a well-formed route — deep links are not a loose bag of fields", () => {
    expect(decodeRoute({ kind: "project-handoff", wsHash: "ws-1" })).toEqual(routes.projectHandoff("ws-1"));
    expect(decodeRoute({ kind: "project-handoff" })).toBeNull();
    expect(decodeRoute({ kind: "project-handoff", wsHash: "" })).toBeNull();
    expect(decodeRoute({ kind: "project-handoff", wsHash: "ws-1", extra: 1 })).toBeNull();
    expect(decodeRoute({ kind: "project-handoff", wsHash: 7 })).toBeNull();
  });

  it("reopens the document after a reload that persisted the retired Handoff tab", () => {
    // v2 record written before the tab was retired…
    expect(decodePanelState({ schemaVersion: 2, view: "tachyonCockpit", route: { kind: "section", section: "handoff" }, wsHash: "ws-1" }))
      .toEqual({ route: routes.projectHandoff("ws-1"), wsHash: "ws-1" });
    // …and the v1 shape that predates routes entirely.
    expect(decodePanelState({ schemaVersion: 1, view: "tachyonCockpit", section: "handoff", wsHash: "ws-1" }))
      .toEqual({ route: routes.projectHandoff("ws-1"), wsHash: "ws-1" });
    // With no workspace recorded there is no document to open — Overview is the honest landing.
    expect(decodePanelState({ schemaVersion: 2, view: "tachyonCockpit", route: { kind: "section", section: "handoff" } }))
      .toEqual({ route: routes.section("overview"), wsHash: undefined });
  });

  it("is a legal pin returnRoute (a non-studio route like any other)", () => {
    const back: CockpitNonStudioRoute = routes.projectHandoff("ws-1");
    const pin = routes.studioEdit("pin", "ws-1", "p-1", back);
    expect(parentRoute(pin)).toEqual(back);
    expect(decodeRoute({ kind: "studio-edit", studio: "pin", wsHash: "ws-1", entityId: "p-1", returnRoute: back })).toEqual(pin);
  });
});
