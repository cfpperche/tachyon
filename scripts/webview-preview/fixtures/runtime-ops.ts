import { emptyRuntimeOpsSnapshot, unavailableRuntimeOpsSnapshot } from "../../../src/runtimeOps/types";
import type { RuntimeOpsSnapshotV1 } from "../../../src/runtimeOps/types";
import { buildRuntimeOpsSnapshot } from "../../../src/runtimeOps/model";
import type { Fixture } from "../routes";

export type RuntimeOpsPreviewState =
  | { state: "loading" }
  | { state: "snapshot"; snapshot: RuntimeOpsSnapshotV1 };

const snapshotFixture = (snapshot: RuntimeOpsSnapshotV1): Fixture<RuntimeOpsPreviewState> => ({
  provenance: "synthetic-edge",
  vm: { state: "snapshot", snapshot },
});

const mixed = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: ["claude", "codex", "grok"],
      agents: [
        {
          workspaceKey: "a1b2c3", workspaceLabel: "tachyon", agentName: "claude", runtime: "claude",
          usage: { runtime: "claude", agent: "claude", inputTokens: 18400, outputTokens: 2200, cacheReadTokens: 40500, lastActivity: "2026-07-09T20:58:00.000Z" },
          lastActivity: "2026-07-09T20:58:00.000Z", runtimeVersion: "2.1.9", versionObservedAt: "2026-07-09T20:58:00.000Z",
          status: "running", attention: { state: "working", stale: false },
          model: { state: "available", value: "Opus 4.8", source: "runtime-profile" },
          resume: { state: "live", reason: "Agent process is currently live." },
          bridge: { currentGeneration: 7, boundGeneration: 7, wired: true, clientState: "ok" },
        },
        {
          workspaceKey: "a1b2c3", workspaceLabel: "tachyon", agentName: "codex", runtime: "codex",
          usage: { runtime: "codex", agent: "codex", inputTokens: 96300, outputTokens: 8700, cacheReadTokens: 124000, lastActivity: "2026-07-09T20:59:30.000Z" },
          lastActivity: "2026-07-09T20:59:30.000Z", runtimeVersion: "0.55.90", versionObservedAt: "2026-07-09T20:59:30.000Z",
          status: "running",
          attention: { state: "throttled", stale: false, rateLimit: { runtime: "codex", scope: "5h", resetAt: 1783634400000, message: "Throttled - see agent terminal" } },
          model: { state: "available", value: "GPT-5.1 Codex", source: "command" },
          resume: { state: "live", reason: "Agent process is currently live." },
          bridge: { currentGeneration: 7, boundGeneration: 6, wired: true, clientState: "suspect" },
        },
      ],
});

const throttled = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["codex"],
  agents: [
    {
      workspaceKey: "ops01", workspaceLabel: "runtime-ops", agentName: "rate-limited", runtime: "codex",
      usage: { runtime: "codex", agent: "RAW_TOKEN_MUST_NOT_RENDER", inputTokens: 200, outputTokens: 40, lastActivity: "RAW_TOKEN_MUST_NOT_RENDER" },
      lastActivity: "RAW_TOKEN_MUST_NOT_RENDER", runtimeVersion: "RAW_PATH_MUST_NOT_RENDER", status: "running",
      attention: {
        state: "throttled", stale: false, matchedLine: "RAW_MATCHED_LINE_MUST_NOT_RENDER",
        rateLimit: {
          runtime: "RAW_THROTTLE_RUNTIME_MUST_NOT_RENDER",
          scope: "RAW_THROTTLE_SCOPE_MUST_NOT_RENDER",
          resetAt: 1783634400000,
          message: "RAW_THROTTLE_LINE_MUST_NOT_RENDER",
        },
      },
      model: { state: "available", value: "RAW_MODEL_VALUE_MUST_NOT_RENDER", source: "command" },
      contextPressure: { state: "unavailable", reason: "RAW_CONTEXT_REASON_MUST_NOT_RENDER" },
      resume: { state: "resumable", reason: "RAW_SESSION_ID_MUST_NOT_RENDER" },
      bridge: { currentGeneration: 8, boundGeneration: 7, wired: true, clientState: "suspect" },
    },
    {
      workspaceKey: "ops01", workspaceLabel: "runtime-ops", agentName: "known-throttle", runtime: "codex",
      lastActivity: "2026-07-09T20:59:30.000Z", status: "running",
      attention: { state: "throttled", stale: false, rateLimit: { runtime: "codex", scope: "5h", resetAt: 1783634400000 } },
      model: { state: "unavailable", reason: "RAW_MODEL_REASON_MUST_NOT_RENDER" },
      resume: { state: "resumable" },
      bridge: { currentGeneration: 8, boundGeneration: 7, wired: true, clientState: "suspect" },
    },
  ],
});

const staleBridge = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["claude"],
  agents: [{
    workspaceKey: "bridge01", workspaceLabel: "bridge-check", agentName: "rebound-agent", runtime: "claude",
    lastActivity: "2026-07-09T20:55:00.000Z", status: "running", attention: { state: "working", stale: false },
    model: { state: "available", value: "Opus 4.8", source: "runtime-profile" },
    resume: { state: "live", reason: "Agent process is currently live." },
    bridge: { currentGeneration: 12, boundGeneration: 11, wired: true },
  }],
});

const longLabel = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["claude"],
  agents: [{
    workspaceKey: "long01", workspaceLabel: "frontend-platform-observability-and-release-engineering", agentName: "migration-coordinator-with-a-deliberately-long-operational-label", runtime: "claude",
    lastActivity: "2026-07-09T20:55:00.000Z", status: "stopping", attention: { state: "needs-input", stale: true },
    model: { state: "available", value: "Claude default", source: "runtime-profile" },
    resume: { state: "fresh-start-only", reason: "The saved transcript is unavailable." },
    bridge: { currentGeneration: 3, boundGeneration: 3, wired: true, clientState: "ok" },
  }],
});

const duplicateWorkspace = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["codex"],
  agents: [
    {
      workspaceKey: "apps-api", workspaceLabel: "apps/api", agentName: "review", runtime: "codex",
      lastActivity: "2026-07-09T20:56:00.000Z", status: "running", attention: { state: "idle", stale: false },
      model: { state: "available", value: "GPT-5.1 Codex", source: "command" }, resume: { state: "live", reason: "Agent process is currently live." },
      bridge: { currentGeneration: 2, boundGeneration: 2, wired: true, clientState: "ok" },
    },
    {
      workspaceKey: "tools-api", workspaceLabel: "tools/api", agentName: "review", runtime: "codex",
      lastActivity: "2026-07-09T20:57:00.000Z", status: "stopped", attention: { state: "unknown", stale: false },
      model: { state: "unavailable", reason: "No model was recorded." }, resume: { state: "resumable", reason: "A resumable session is recorded." },
      bridge: { currentGeneration: 2, boundGeneration: 2, wired: false },
    },
  ],
});

export const runtimeOpsFixtures: Record<string, Fixture<RuntimeOpsPreviewState>> = {
  default: snapshotFixture(mixed),
  loading: { provenance: "synthetic-edge", vm: { state: "loading" } },
  empty: snapshotFixture(emptyRuntimeOpsSnapshot(new Date("2026-07-09T21:00:00.000Z"))),
  error: snapshotFixture(unavailableRuntimeOpsSnapshot(new Date("2026-07-09T21:00:00.000Z"))),
  mixed: snapshotFixture(mixed),
  throttled: snapshotFixture(throttled),
  "stale-bridge": snapshotFixture(staleBridge),
  "long-label": snapshotFixture(longLabel),
  "duplicate-workspace": snapshotFixture(duplicateWorkspace),
};
