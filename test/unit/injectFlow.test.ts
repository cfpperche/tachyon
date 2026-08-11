import { describe, it, expect } from "vitest";
import { injectTargets, isEvidencedWorking, previewBody, submitRefuseReason } from "../../src/prompts/injectFlow.js";

describe("injectTargets", () => {
  it("keeps the running member of the supplied agent collection", () => {
    const targets = injectTargets([
      { name: "codex", kind: "agent", running: true },
      { name: "claude", kind: "agent", running: true, stopping: true },
      { name: "dead", kind: "agent", running: false, dead: true },
      { name: "stopped", kind: "agent", running: false },
    ]);
    expect(targets.map((t) => t.name)).toEqual(["codex"]);
  });
});

describe("submitRefuseReason", () => {
  it("refuses working, throttled, and occupied composer", () => {
    expect(submitRefuseReason("working", false, true)).toBe("working");
    expect(submitRefuseReason("throttled", false, undefined)).toBe("throttled");
    expect(submitRefuseReason("idle", true, undefined)).toBe("composer-occupied");
    expect(submitRefuseReason(undefined, false, undefined)).toBeUndefined();
    expect(submitRefuseReason("needs-input", false, undefined)).toBeUndefined();
  });

  it.each(["spawn", "restart", "resume", "fork", "crash-recovery"])(
    "%s: synthetic working without turn evidence does not refuse the human submit",
    () => {
      expect(submitRefuseReason("working", false, false)).toBeUndefined();
      expect(submitRefuseReason("working", false, undefined)).toBeUndefined();
      expect(submitRefuseReason("working", false, true)).toBe("working");
      expect(isEvidencedWorking("working", false)).toBe(false);
    },
  );
});

describe("previewBody", () => {
  it("truncates long bodies", () => {
    const long = "x".repeat(2000);
    const p = previewBody(long, 100);
    expect(p.length).toBeLessThan(long.length);
    expect(p).toContain("[preview truncated]");
  });
});
