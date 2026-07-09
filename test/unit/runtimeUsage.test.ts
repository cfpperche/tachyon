import { describe, expect, it } from "vitest";
import { buildRuntimeUsageRows } from "../../src/runtimeUsage/model.js";

describe("buildRuntimeUsageRows", () => {
  it("shows unavailable when a detected runtime has no honest usage source", () => {
    expect(buildRuntimeUsageRows(["codex"], [])).toEqual([
      {
        runtime: "codex",
        label: "$(pulse) Codex",
        detail: "usage unavailable",
        description: "installed; usage unavailable",
        status: "unavailable",
      },
    ]);
  });

  it("aggregates logged token usage by runtime", () => {
    const rows = buildRuntimeUsageRows(["claude"], [
      { runtime: "claude", agent: "a", inputTokens: 1200, outputTokens: 50, cacheReadTokens: 300, lastActivity: "2026-07-09T10:00:00.000Z" },
      { runtime: "claude", agent: "b", inputTokens: 900, outputTokens: 75, cacheCreationTokens: 200, lastActivity: "2026-07-09T11:00:00.000Z" },
    ]);

    expect(rows[0]).toMatchObject({
      runtime: "claude",
      label: "$(pulse) Claude",
      detail: "2k in / 125 out / 500 cache",
      description: "2 agents; last usage 2026-07-09T11:00:00.000Z",
      status: "available",
    });
  });

  it("surfaces current throttles without inventing usage numbers", () => {
    const rows = buildRuntimeUsageRows(
      ["grok"],
      [],
      [{ runtime: "grok", agent: "reviewer", line: "Usage limit reached. Please try again later" }],
    );

    expect(rows[0]).toMatchObject({
      runtime: "grok",
      label: "$(warning) Grok",
      detail: "usage unavailable",
      description: "reviewer throttled; Usage limit reached. Please try again later",
      status: "throttled",
    });
  });
});
