import { describe, it, expect } from "vitest";
import { nodeCanSignal, nodeRuntimeOf } from "@tachyon/engine/pipeline/preflight.js";

describe("nodeCanSignal (spec 232 → 236)", () => {
  const base = { bridgeUp: true } as const;

  it("exit-based done never needs the Bridge → ok (even bridge down)", () => {
    expect(nodeCanSignal({ done: "exit", runtime: "other", bridgeUp: false })).toBe("ok");
  });

  it("a signal-based node with the Bridge DOWN → cannot", () => {
    expect(nodeCanSignal({ done: "signal", runtime: "codex", bridgeUp: false })).toBe("cannot");
  });

  it("codex with the Bridge up → ok (Tachyon injects tachyon_bridge)", () => {
    expect(nodeCanSignal({ ...base, done: "signal", runtime: "codex" })).toBe("ok");
  });

  it("claude with the Bridge up → ok (spec 236: Tachyon always injects --mcp-config, no .mcp.json needed)", () => {
    expect(nodeCanSignal({ ...base, done: "signal", runtime: "claude" })).toBe("ok");
  });

  it("an unknown runtime → unprovable (never an optimistic ok)", () => {
    expect(nodeCanSignal({ ...base, done: "signal", runtime: "other" })).toBe("unprovable");
  });

  it("spec 236: a --safe-mode claude node → cannot (MCP disabled, the injected Bridge can't load)", () => {
    expect(nodeCanSignal({ ...base, done: "signal", runtime: "claude", mcpDisabled: true })).toBe("cannot");
    // but exit-based completion never needs the Bridge, so --safe-mode is irrelevant there
    expect(nodeCanSignal({ ...base, done: "exit", runtime: "claude", mcpDisabled: true })).toBe("ok");
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
