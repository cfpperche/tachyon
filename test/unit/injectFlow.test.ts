import { describe, it, expect } from "vitest";
import { injectTargets, previewBody, submitRefuseReason } from "../../src/prompts/injectFlow.js";

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
    expect(submitRefuseReason("working", false)).toBe("working");
    expect(submitRefuseReason("throttled", false)).toBe("throttled");
    expect(submitRefuseReason("idle", true)).toBe("composer-occupied");
    expect(submitRefuseReason(undefined, false)).toBeUndefined();
    expect(submitRefuseReason("needs-input", false)).toBeUndefined();
  });
});

describe("previewBody", () => {
  it("truncates long bodies", () => {
    const long = "x".repeat(2000);
    const p = previewBody(long, 100);
    expect(p.length).toBeLessThan(long.length);
    expect(p).toContain("[preview truncated]");
  });
});
