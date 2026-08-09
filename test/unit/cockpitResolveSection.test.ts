import { describe, it, expect } from "vitest";
import { resolveCockpitSection, isCockpitSectionId } from "../../src/sections/resolveSection.js";
import { WEBVIEW_SURFACES } from "../../src/webview/surfaces.js";

describe("resolveCockpitSection (spec 410)", () => {
  it("keeps known sections", () => {
    expect(resolveCockpitSection("approvals")).toBe("approvals");
    expect(resolveCockpitSection("fleet")).toBe("fleet");
  });

  it("falls back to overview for unknown or retired ids", () => {
    expect(resolveCockpitSection("nope")).toBe("overview");
    expect(resolveCockpitSection(undefined)).toBe("overview");
    expect(resolveCockpitSection("")).toBe("overview");
    expect(resolveCockpitSection(null)).toBe("overview");
  });

  it("isCockpitSectionId is a closed check", () => {
    expect(isCockpitSectionId("mission")).toBe(true);
    expect(isCockpitSectionId("not-a-section")).toBe(false);
  });
});

describe("WEBVIEW_SURFACES hostKind (spec 410 / 279)", () => {
  it("every surface declares hostKind", () => {
    const missing = WEBVIEW_SURFACES.filter((s) => !s.hostKind).map((s) => s.viewId);
    expect(missing, `missing hostKind: ${missing.join(", ")}`).toEqual([]);
  });

  // t-610705 (Phase E cleanup, 2026-07-22) — two tests that used to live here are gone, not just
  // green: "multi-instance class is tagged standalone-multi" (task-detail/activity/probes/handoff's
  // thin-host exception — Phase C.1/C.2/C.3 closed all three into Control subroutes/sections) and
  // "Approvals is legacy-redirect into cockpit approvals" (Approvals' manager is a pure redirect stub
  // with no createWebviewPanel call left — same shape as every other retired panel, it just hadn't
  // dropped out of WEBVIEW_SURFACES yet). Both `standalone-multi` and `legacy-redirect` (+ the
  // `cockpitSectionId` field it paired with) were removed from `WebviewHostKind`/`WebviewSurface`
  // itself, so both invariants are compiler-enforced now — a stronger guarantee than a runtime
  // filter/lookup assertion.
});
