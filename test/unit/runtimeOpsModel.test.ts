import { describe, expect, it } from "vitest";
import { buildRuntimeOpsSnapshot, projectBridgeHealth } from "../../src/runtimeOps/model.js";
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
    expect(snapshot.summary).toEqual({ runtimes: 3, managedAgents: 1, activeAgents: 0, throttled: 0, bridgeIssues: 0 });
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

describe("Runtime Ops operational projection", () => {
  it("maps Bridge generations and coordinator states without treating cancelled as failure or health", () => {
    expect(projectBridgeHealth({ currentGeneration: 3, boundGeneration: 3, wired: true, clientState: "ok" })).toMatchObject({ state: "ok" });
    expect(projectBridgeHealth({ currentGeneration: 3, boundGeneration: 2, wired: true })).toMatchObject({ state: "suspect" });
    expect(projectBridgeHealth({ currentGeneration: 3, boundGeneration: 3, wired: true, clientState: "rebinding" })).toMatchObject({ state: "rebinding" });
    expect(projectBridgeHealth({ currentGeneration: 3, boundGeneration: 3, wired: true, clientState: "failed" })).toMatchObject({ state: "failed" });
    expect(projectBridgeHealth({ currentGeneration: 3, boundGeneration: 3, wired: true, clientState: "cancelled" })).toEqual({
      state: "unknown",
      reason: "A cancelled prior incarnation was not reset.",
      currentGeneration: 3,
      boundGeneration: 3,
    });
    expect(projectBridgeHealth({ currentGeneration: 3, boundGeneration: 0, wired: false })).toMatchObject({ state: "not-wired" });
  });

  it("counts active, throttled, and Bridge issue agents from allowlisted details", () => {
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: [],
      agents: [
        {
          workspaceKey: "ws", workspaceLabel: "app", agentName: "live", runtime: "codex", status: "running",
          attention: { state: "throttled", stale: false, rateLimit: { scope: "5h", message: "Throttled - see agent terminal" } },
          bridge: { currentGeneration: 2, boundGeneration: 1, wired: true },
        },
        { workspaceKey: "ws", workspaceLabel: "app", agentName: "stopped", runtime: "codex", status: "stopped" },
      ],
    });
    expect(snapshot.summary).toMatchObject({ activeAgents: 1, throttled: 1, bridgeIssues: 1 });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain("Throttled - see agent terminal");
    expect(serialized).not.toContain("raw terminal limit line");
  });
});

describe("Runtime Ops workspace labels", () => {
  it("uses useful bounded parent labels for shallow POSIX paths", () => {
    const labels = buildWorkspaceLabels([
      { key: "a", name: "app", root: "/company/one/team/app" },
      { key: "b", name: "app", root: "/company/two/team/app" },
      { key: "c", name: "solo", root: "/company/solo" },
    ]);
    expect(Object.fromEntries(labels)).toEqual({ a: "app (one/team)", b: "app (two/team)", c: "solo" });
  });

  it("includes Windows volume roots when duplicate parent suffixes cross volumes", () => {
    const labels = buildWorkspaceLabels([
      { key: "c", name: "app", root: "C:\\repo\\app" },
      { key: "d", name: "app", root: "D:\\repo\\app" },
    ]);
    expect(Object.fromEntries(labels)).toEqual({ c: "app (C:/repo)", d: "app (D:/repo)" });
  });

  it("adds stable opaque discriminators for identical roots without exposing more of the parent path", () => {
    const labels = buildWorkspaceLabels([
      { key: "a", name: "app", root: "C:\\private\\customer\\repo\\app" },
      { key: "b", name: "app", root: "C:\\private\\customer\\repo\\app" },
    ]);
    expect(labels.get("a")).toMatch(/^app \(C:\/customer\/repo \[id-[0-9a-f]{12}\]\)$/);
    expect(labels.get("b")).toMatch(/^app \(C:\/customer\/repo \[id-[0-9a-f]{12}\]\)$/);
    expect(labels.get("a")).not.toBe(labels.get("b"));
    expect([...labels.values()].join(" ")).not.toContain("private");
    const reordered = buildWorkspaceLabels([
      { key: "b", name: "app", root: "C:\\private\\customer\\repo\\app" },
      { key: "a", name: "app", root: "C:\\private\\customer\\repo\\app" },
    ]);
    expect(reordered.get("a")).toBe(labels.get("a"));
    expect(reordered.get("b")).toBe(labels.get("b"));
  });

  it("uses opaque UNC disambiguation without exposing server or share names", () => {
    const labels = buildWorkspaceLabels([
      { key: "a", name: "app", root: "\\\\corp-server\\finance-share\\private-a\\program-a\\team\\app" },
      { key: "b", name: "app", root: "\\\\corp-server\\finance-share\\private-b\\program-b\\team\\app" },
    ]);
    const visible = [...labels.values()].join(" ");
    expect(visible).toMatch(/^app \(unc-[0-9a-f]{12}\/program-a\/team\) app \(unc-[0-9a-f]{12}\/program-b\/team\)$/);
    expect(visible).not.toContain("corp-server");
    expect(visible).not.toContain("finance-share");
    expect(visible).not.toContain("private-a");
    expect(visible).not.toContain("private-b");
    expect(new Set(labels.values()).size).toBe(2);
  });

  it("bounds deep colliding paths and falls back to opaque workspace discriminators", () => {
    const labels = buildWorkspaceLabels([
      { key: "posix-a", name: "repo", root: "/restricted/account-a/program-a/squad/team/repo" },
      { key: "posix-b", name: "repo", root: "/restricted/account-b/program-b/squad/team/repo" },
      { key: "unc-a", name: "repo", root: "\\\\private-server\\restricted-share\\account-a\\program-a\\squad\\team\\repo" },
      { key: "unc-b", name: "repo", root: "\\\\private-server\\restricted-share\\account-b\\program-b\\squad\\team\\repo" },
    ]);
    const visible = [...labels.values()].join(" ");
    expect(labels.get("posix-a")).toMatch(/^repo \(squad\/team \[id-[0-9a-f]{12}\]\)$/);
    expect(labels.get("posix-b")).toMatch(/^repo \(squad\/team \[id-[0-9a-f]{12}\]\)$/);
    expect(labels.get("unc-a")).toMatch(/^repo \(unc-[0-9a-f]{12}\/squad\/team \[id-[0-9a-f]{12}\]\)$/);
    expect(labels.get("unc-b")).toMatch(/^repo \(unc-[0-9a-f]{12}\/squad\/team \[id-[0-9a-f]{12}\]\)$/);
    expect(new Set(labels.values()).size).toBe(4);
    for (const forbidden of ["restricted", "account-a", "account-b", "program-a", "program-b", "private-server", "restricted-share"]) {
      expect(visible).not.toContain(forbidden);
    }
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
