import { describe, it, expect } from "vitest";
import { mapStudioSubmitResult } from "../../src/webview/studioSubmit.js";

describe("mapStudioSubmitResult (t-610705, D1d entityId threading)", () => {
  it("carries newEntityId through on a clean (no-error) result", () => {
    expect(mapStudioSubmitResult(undefined, "validation/x-save-failed", "build")).toEqual({ status: "ok", entityId: "build" });
  });

  it("omits entityId entirely when newEntityId was never passed (edit-mode save)", () => {
    expect(mapStudioSubmitResult(undefined, "validation/x-save-failed")).toEqual({ status: "ok" });
  });

  it("still includes an empty-string entityId rather than silently dropping it (probe finding: falsy filtering)", () => {
    expect(mapStudioSubmitResult(undefined, "validation/x-save-failed", "")).toEqual({ status: "ok", entityId: "" });
  });

  it("never attaches entityId on an error result, regardless of newEntityId", () => {
    expect(mapStudioSubmitResult(["name: required"], "validation/x-save-failed", "build")).toEqual({
      status: "error",
      error: { code: "validation/x-save-failed", message: "name: required", source: "validation" },
    });
  });

  it("resolves the async path the same way", async () => {
    await expect(mapStudioSubmitResult(Promise.resolve(undefined), "validation/x-save-failed", "build")).resolves.toEqual({ status: "ok", entityId: "build" });
    await expect(mapStudioSubmitResult(Promise.resolve(["bad"]), "validation/x-save-failed", "build")).resolves.toEqual({
      status: "error",
      error: { code: "validation/x-save-failed", message: "bad", source: "validation" },
    });
  });
});
