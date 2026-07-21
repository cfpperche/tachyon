import { describe, it, expect } from "vitest";
import { resolveCockpitSection, isCockpitSectionId } from "../../src/cockpit/resolveSection.js";
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

describe("WEBVIEW_SURFACES editorHome (spec 410 / 279)", () => {
  it("every surface declares editorHome", () => {
    const missing = WEBVIEW_SURFACES.filter((s) => !s.editorHome).map((s) => s.viewId);
    expect(missing, `missing editorHome: ${missing.join(", ")}`).toEqual([]);
  });

  it("Approvals is legacy-redirect into cockpit approvals", () => {
    const a = WEBVIEW_SURFACES.find((s) => s.viewId === "tachyonApprovals");
    expect(a?.editorHome).toBe("legacy-redirect");
    expect(a?.cockpitSectionId).toBe("approvals");
  });

  it("multi-instance class is tagged standalone-multi", () => {
    const multi = WEBVIEW_SURFACES.filter((s) => s.editorHome === "standalone-multi").map((s) => s.view);
    // t-610705 Phase C.1 — task-detail's multi-instance exception closed (it's a Control subroute now).
    // t-610705 Phase C.2 — activity/probes' multi-instance exception closed the same way.
    expect(multi.sort()).toEqual(["handoff"].sort());
  });
});
