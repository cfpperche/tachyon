import { describe, expect, it } from "vitest";
import { buildRuntimeOpsSnapshot } from "../../src/runtimeOps/model.js";
import { buildWorkspaceLabels } from "../../src/runtimeOps/workspaceLabels.js";

describe("Runtime Ops projection", () => {
  it("unions PATH and managed runtimes, deduplicates, and sorts by display label", () => {
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: ["grok", "codex", "codex"],
      agents: [{
        workspaceKey: "ws-a",
        workspaceLabel: "alpha",
        agentName: "claude",
        runtime: "claude",
      }],
    });

    expect(snapshot.runtimes.map((row) => row.runtime)).toEqual(["claude", "codex", "grok"]);
    expect(snapshot.summary).toEqual({ runtimes: 3, managedAgents: 1 });
    expect(snapshot.runtimes[0].availability).toEqual({
      pathDetected: false,
      managed: true,
      detail: "Managed session observed; PATH not detected in this host",
    });
    expect(snapshot.runtimes[1].availability.detail).toBe("PATH detected; authentication not checked");
  });

  it("aggregates already-normalized per-agent usage and preserves runtime semantics", () => {
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: ["codex", "claude"],
      agents: [
        {
          workspaceKey: "ws-a", workspaceLabel: "app (one)", agentName: "a", runtime: "codex",
          usage: { runtime: "codex", agent: "a", inputTokens: 2000, outputTokens: 100, lastActivity: "2026-07-09T20:00:00.000Z" },
        },
        {
          workspaceKey: "ws-b", workspaceLabel: "app (two)", agentName: "b", runtime: "codex",
          usage: { runtime: "codex", agent: "b", inputTokens: 3000, outputTokens: 200, cacheReadTokens: 50, lastActivity: "2026-07-09T21:00:00.000Z" },
        },
        {
          workspaceKey: "ws-a", workspaceLabel: "app (one)", agentName: "c", runtime: "claude",
          usage: { runtime: "claude", agent: "c", inputTokens: 500, outputTokens: 20, lastActivity: "2026-07-09T19:00:00.000Z" },
        },
      ],
    });

    const codex = snapshot.runtimes.find((row) => row.runtime === "codex")!;
    expect(codex.usage).toMatchObject({
      state: "available",
      value: { inputTokens: 5000, outputTokens: 300, cacheReadTokens: 50, semantics: "latest-cumulative" },
      observedAt: "2026-07-09T21:00:00.000Z",
    });
    const claude = snapshot.runtimes.find((row) => row.runtime === "claude")!;
    expect(claude.usage).toMatchObject({ state: "available", value: { semantics: "summed-deltas" } });
  });

  it("uses explicit unavailable reasons and the latest observed version", () => {
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: ["codex", "grok"],
      agents: [
        { workspaceKey: "ws", workspaceLabel: "app", agentName: "old", runtime: "codex", runtimeVersion: "1.0", versionObservedAt: "2026-07-09T19:00:00.000Z" },
        { workspaceKey: "ws", workspaceLabel: "app", agentName: "new", runtime: "codex", runtimeVersion: "1.2", versionObservedAt: "2026-07-09T20:00:00.000Z" },
      ],
    });

    expect(snapshot.runtimes.find((row) => row.runtime === "codex")?.version).toMatchObject({ state: "available", value: "1.2" });
    const grok = snapshot.runtimes.find((row) => row.runtime === "grok")!;
    expect(grok.usage).toEqual({ state: "unavailable", reason: "No Tachyon-managed session has usage data." });
    expect(grok.version).toEqual({ state: "unavailable", reason: "No normalized runtime version was observed." });
  });
});

describe("Runtime Ops workspace labels", () => {
  it("uses the shortest unique parent suffix for duplicate basenames", () => {
    const labels = buildWorkspaceLabels([
      { key: "a", name: "app", root: "/company/one/team/app" },
      { key: "b", name: "app", root: "/company/two/team/app" },
      { key: "c", name: "solo", root: "/company/solo" },
    ]);
    expect(Object.fromEntries(labels)).toEqual({ a: "app (one/team)", b: "app (two/team)", c: "solo" });
  });

  it("keeps full workspace roots out of the snapshot", () => {
    const secretRoot = "/home/private/customer/repo";
    const labels = buildWorkspaceLabels([{ key: "opaque", name: "repo", root: secretRoot }]);
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: [],
      agents: [{ workspaceKey: "opaque", workspaceLabel: labels.get("opaque")!, agentName: "worker", runtime: "codex" }],
    });
    expect(JSON.stringify(snapshot)).not.toContain(secretRoot);
    expect(snapshot.runtimes[0].agents[0].key).toBe("opaque:worker");
  });
});
