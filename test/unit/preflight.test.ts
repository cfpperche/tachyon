import { describe, it, expect } from "vitest";
import { nodeCanSignal, nodeRuntimeOf } from "../../src/pipeline/preflight";

describe("nodeCanSignal (spec 232 → 236)", () => {
  const base = { bridgeUp: true } as const;

  it("exit-based done never needs the Bridge → ok (even bridge down)", () => {
    expect(nodeCanSignal({ done: "exit", runtime: "other", bridgeUp: false })).toBe("ok");
    expect(nodeCanSignal({ done: "exit_then_verify", runtime: "codex", bridgeUp: false })).toBe("ok");
  });

  it("a signal-based node with the Bridge DOWN → cannot", () => {
    expect(nodeCanSignal({ done: "signal", runtime: "codex", bridgeUp: false })).toBe("cannot");
    expect(nodeCanSignal({ done: "signal_then_verify", runtime: "claude", bridgeUp: false })).toBe("cannot");
  });

  it("codex with the Bridge up → ok (Tachyon injects tachyon_bridge)", () => {
    expect(nodeCanSignal({ ...base, done: "signal", runtime: "codex" })).toBe("ok");
  });

  it("claude with the Bridge up → ok (spec 236: Tachyon always injects --mcp-config, no .mcp.json needed)", () => {
    expect(nodeCanSignal({ ...base, done: "signal_then_verify", runtime: "claude" })).toBe("ok");
    expect(nodeCanSignal({ ...base, done: "signal", runtime: "claude" })).toBe("ok");
  });

  it("an unknown runtime → unprovable (never an optimistic ok)", () => {
    expect(nodeCanSignal({ ...base, done: "signal", runtime: "other" })).toBe("unprovable");
  });
});

describe("nodeRuntimeOf", () => {
  it("buckets the binary", () => {
    expect(nodeRuntimeOf("claude")).toBe("claude");
    expect(nodeRuntimeOf("codex")).toBe("codex");
    expect(nodeRuntimeOf("sh")).toBe("other");
    expect(nodeRuntimeOf("")).toBe("other");
  });
});
