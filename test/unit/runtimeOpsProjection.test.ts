import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRuntimeOpsSnapshot,
  isRuntimeOpsSnapshotV1,
  mergeRuntimeOpsSnapshotsV1,
  parseRuntimeOpsSnapshot,
  parseRuntimeOpsSnapshotV1,
} from "../../src/runtime-api/runtimeOpsProjection.js";
import type { RuntimeOpsSnapshotV1, RuntimeOpsSnapshotV2 } from "../../src/runtimeOps/types.js";
import { isWorkspaceQueryV1, workspaceRuntimeOpsViewSuccessV1 } from "../../src/engine-service/protocol.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { runtimeOpsFleetView, workspaceRuntimeOpsTarget } from "../../src/shell/RuntimeOpsTarget.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Runtime Ops persistent projection", () => {
  it("strictly validates identities, counts and closed nested values", () => {
    const value = snapshot("ws-one", "alpha", "2026-07-14T12:00:00.000Z", 10);
    expect(parseRuntimeOpsSnapshotV1(value)).toEqual(value);
    expect(isRuntimeOpsSnapshotV1({ ...value, extra: true })).toBe(false);
    expect(isRuntimeOpsSnapshotV1({ ...value, summary: { ...value.summary, managedAgents: 2 } })).toBe(false);
    expect(isRuntimeOpsSnapshotV1({
      ...value,
      runtimes: [{ ...value.runtimes[0]!, agents: [{ ...value.runtimes[0]!.agents[0]!, key: "redirected" }] }],
    })).toBe(false);
    expect(isRuntimeOpsSnapshotV1({
      ...value,
      runtimes: [{
        ...value.runtimes[0]!,
        agents: [{ ...value.runtimes[0]!.agents[0]!, attention: { state: "working", stale: false, rateLimit: { scope: "5h" } } }],
      }],
    })).toBe(false);
    expect(isWorkspaceQueryV1({ schemaVersion: 1, method: "runtime-ops.view", input: {} })).toBe(true);
    expect(isWorkspaceQueryV1({ schemaVersion: 1, method: "runtime-ops.view", input: { refreshDetection: true } })).toBe(true);
    expect(isWorkspaceQueryV1({ schemaVersion: 1, method: "runtime-ops.view", input: { refreshDetection: false } })).toBe(false);
    expect(isWorkspaceQueryV1({ schemaVersion: 1, method: "runtime-ops.view", input: { extra: true } })).toBe(false);
  });

  it("merges authoritative per-workspace rows without losing usage or fleet identity", () => {
    const first = snapshot("ws-one", "alpha", "2026-07-14T12:00:00.000Z", 10);
    const second = snapshot("ws-two", "beta", "2026-07-14T12:01:00.000Z", 20);

    const merged = mergeRuntimeOpsSnapshotsV1([first, second]);

    expect(merged).toMatchObject({
      generatedAt: "2026-07-14T12:01:00.000Z",
      summary: { runtimes: 1, managedAgents: 2, activeAgents: 2 },
      runtimes: [{
        runtime: "codex",
        availability: { pathDetected: true, managed: true },
        usage: { state: "available", value: { inputTokens: 30, semantics: "latest-cumulative" } },
        workspaces: [{ key: "ws-one" }, { key: "ws-two" }],
        agents: [{ key: "ws-one:alpha" }, { key: "ws-two:beta" }],
      }],
    });
  });

  it("preserves schema V2 and selects the newest agreed provider observation", () => {
    const first = snapshotV2("ws-one", "alpha", "2026-07-14T12:00:00.000Z", 10);
    const second = snapshotV2("ws-two", "beta", "2026-07-14T12:01:00.000Z", 20, true);

    expect(parseRuntimeOpsSnapshot(first)).toEqual(first);
    expect(isRuntimeOpsSnapshot(first)).toBe(true);
    expect(mergeRuntimeOpsSnapshotsV1([first, second])).toMatchObject({
      schemaVersion: 2,
      generatedAt: "2026-07-14T12:01:00.000Z",
      providerCapacity: [
        {
          provider: "codex",
          configuration: { state: "enabled", sources: ["cli"] },
          quota: { state: "available", observedAt: "2026-07-14T12:01:00.000Z", windows: [{ usedPercent: 37 }] },
        },
        { provider: "claude", configuration: { state: "disabled" } },
      ],
    });
  });

  it("refuses to merge conflicting provider configuration across workspace engines", () => {
    const first = snapshotV2("ws-one", "alpha", "2026-07-14T12:00:00.000Z", 10);
    const second = snapshotV2("ws-two", "beta", "2026-07-14T12:01:00.000Z", 20);
    second.providerCapacity[0] = {
      provider: "codex",
      scope: "provider-account",
      configuration: { state: "disabled" },
      quota: { state: "unavailable", observedAt: second.generatedAt, reason: "source-disabled" },
    };

    expect(() => mergeRuntimeOpsSnapshotsV1([first, second])).toThrow(/configuration disagrees/);
  });

  it("queries each authenticated client and builds one fleet view", async () => {
    const first = client("ws-one", "alpha", "2026-07-14T12:00:00.000Z", 10);
    const second = client("ws-two", "beta", "2026-07-14T12:01:00.000Z", 20);

    const view = await runtimeOpsFleetView([
      workspaceRuntimeOpsTarget(first),
      workspaceRuntimeOpsTarget(second),
    ]);

    expect(view.summary).toMatchObject({ runtimes: 1, managedAgents: 2 });
    expect(first.queries).toEqual([{ schemaVersion: 1, method: "runtime-ops.view", input: {} }]);
    expect(second.queries).toEqual([{ schemaVersion: 1, method: "runtime-ops.view", input: {} }]);
  });

  it("requests an explicit daemon-side detection refresh without widening the query", async () => {
    const targetClient = client("ws-one", "alpha", "2026-07-14T12:00:00.000Z", 10);

    await runtimeOpsFleetView([workspaceRuntimeOpsTarget(targetClient)], true);

    expect(targetClient.queries).toEqual([{
      schemaVersion: 1,
      method: "runtime-ops.view",
      input: { refreshDetection: true },
    }]);
  });
});

function client(workspaceKey: string, agent: string, generatedAt: string, inputTokens: number): FakeWorkspaceClient {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-ops-target-"));
  roots.push(root);
  const identity = projectionIdentity(root);
  return new FakeWorkspaceClient({
    identity,
    snapshot: projectionSnapshot(identity),
    query: async (query) => {
      if (query.method !== "runtime-ops.view") throw new Error("unexpected query");
      return workspaceRuntimeOpsViewSuccessV1(snapshot(workspaceKey, agent, generatedAt, inputTokens));
    },
  });
}

function snapshot(workspaceKey: string, agentName: string, generatedAt: string, inputTokens: number): RuntimeOpsSnapshotV1 {
  return {
    schemaVersion: 1,
    generatedAt,
    summary: { runtimes: 1, managedAgents: 1, activeAgents: 1, throttled: 0, bridgeIssues: 0 },
    runtimes: [{
      key: "runtime:codex",
      runtime: "codex",
      label: "Codex",
      availability: { pathDetected: true, managed: true },
      usage: {
        state: "available",
        value: { inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, semantics: "latest-cumulative" },
        source: "activity-log",
        observedAt: generatedAt,
      },
      lastActivity: { state: "available", value: generatedAt, source: "activity-log", observedAt: generatedAt },
      version: { state: "available", value: "0.56.4", source: "activity-log", observedAt: generatedAt },
      workspaces: [{ key: workspaceKey, label: workspaceKey }],
      agents: [{
        key: `${workspaceKey}:${agentName}`,
        name: agentName,
        workspaceKey,
        status: "running",
        attention: { state: "working", stale: false },
        model: { state: "available", value: "Codex default", source: "runtime-profile" },
        modelObserved: { state: "unavailable" },
        modelDivergence: false,
        resume: { state: "live" },
        bridge: { state: "ok", currentGeneration: 1, boundGeneration: 1 },
        contextPressure: { state: "unavailable" },
      }],
    }],
  };
}

function snapshotV2(
  workspaceKey: string,
  agentName: string,
  generatedAt: string,
  inputTokens: number,
  quotaAvailable = false,
): RuntimeOpsSnapshotV2 {
  const base = snapshot(workspaceKey, agentName, generatedAt, inputTokens);
  return {
    ...base,
    schemaVersion: 2,
    providerCapacity: [
      {
        provider: "codex",
        scope: "provider-account",
        configuration: { state: "enabled", sources: ["cli"] },
        quota: quotaAvailable
          ? {
              state: "available",
              source: "cli",
              confidence: "exact",
              observedAt: generatedAt,
              freshness: { state: "fresh" },
              windows: [{ name: "session", usedPercent: 37 }],
            }
          : { state: "unavailable", source: "cli", observedAt: generatedAt, reason: "not-observed" },
      },
      {
        provider: "claude",
        scope: "provider-account",
        configuration: { state: "disabled" },
        quota: { state: "unavailable", observedAt: generatedAt, reason: "source-disabled" },
      },
    ],
  };
}

describe("t-019dac/t-e3bae0 Runtime Ops summary host mem + agent resources", () => {
  it("accepts hostMem fields and per-agent resources on V2 snapshots", async () => {
    const { parseRuntimeOpsSnapshot } = await import("../../src/runtime-api/runtimeOpsProjection.js");
    const { buildRuntimeOpsSnapshot } = await import("../../src/runtimeOps/model.js");
    const snap = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-18T15:00:00.000Z",
      detectedRuntimes: ["codex"],
      agents: [{
        workspaceKey: "ws",
        workspaceLabel: "app",
        agentName: "hermes",
        runtime: "codex",
        status: "running",
        resources: { cpuPct: 12.5, memMb: 153 },
      }],
      hostMemory: {
        hostMemAvailableMb: 2048,
        hostMemTotalMb: 16384,
        recommendedVitestWorkers: 4,
      },
    });
    expect(() => parseRuntimeOpsSnapshot(snap)).not.toThrow();
    const parsed = parseRuntimeOpsSnapshot(snap);
    expect(parsed.summary.hostMemAvailableMb).toBe(2048);
    expect(parsed.runtimes[0].agents[0].resources).toEqual({ cpuPct: 12.5, memMb: 153 });
  });
});
