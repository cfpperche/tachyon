import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";

describe("container-generated delegation behavior", () => {
  it("mechanism-only canonical Delivery reuses one worktree through review completion", () => {
    const parsed = parseConfig("settings:\n  delivery:\n    mode: canonical\n    handoffSafety: mechanism-only\nagents:\n  worker:\n    cmd: codex\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.settings.delivery).toEqual({ mode: "canonical", handoffSafety: "mechanism-only" });
  });
});
