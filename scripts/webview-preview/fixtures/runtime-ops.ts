import { emptyRuntimeOpsSnapshot, unavailableRuntimeOpsSnapshot } from "../../../src/runtimeOps/types";
import type { RuntimeOpsSnapshotV1 } from "../../../src/runtimeOps/types";
import { buildRuntimeOpsSnapshot } from "../../../src/runtimeOps/model";
import type { Fixture } from "../routes";

export const runtimeOpsFixtures: Record<string, Fixture<RuntimeOpsSnapshotV1>> = {
  default: {
    provenance: "synthetic-edge",
    vm: buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: ["claude", "codex", "grok"],
      agents: [
        {
          workspaceKey: "a1b2c3", workspaceLabel: "tachyon", agentName: "claude", runtime: "claude",
          usage: { runtime: "claude", agent: "claude", inputTokens: 18400, outputTokens: 2200, cacheReadTokens: 40500, lastActivity: "2026-07-09T20:58:00.000Z" },
          lastActivity: "2026-07-09T20:58:00.000Z", runtimeVersion: "2.1.9", versionObservedAt: "2026-07-09T20:58:00.000Z",
          status: "running", attention: { state: "working", stale: false },
          model: { state: "available", value: "Fable 5", source: "runtime-profile" },
          resume: { state: "live", reason: "Agent process is currently live." },
          bridge: { currentGeneration: 7, boundGeneration: 7, wired: true, clientState: "ok" },
        },
        {
          workspaceKey: "a1b2c3", workspaceLabel: "tachyon", agentName: "codex", runtime: "codex",
          usage: { runtime: "codex", agent: "codex", inputTokens: 96300, outputTokens: 8700, cacheReadTokens: 124000, lastActivity: "2026-07-09T20:59:30.000Z" },
          lastActivity: "2026-07-09T20:59:30.000Z", runtimeVersion: "0.55.90", versionObservedAt: "2026-07-09T20:59:30.000Z",
          status: "running",
          attention: { state: "throttled", stale: false, rateLimit: { runtime: "codex", scope: "5h", resetAt: 1783634400000, message: "Throttled - see agent terminal" } },
          model: { state: "available", value: "GPT-5.6", source: "command" },
          resume: { state: "live", reason: "Agent process is currently live." },
          bridge: { currentGeneration: 7, boundGeneration: 6, wired: true, clientState: "suspect" },
        },
      ],
    }),
  },
  empty: {
    provenance: "synthetic-edge",
    vm: emptyRuntimeOpsSnapshot(new Date("2026-07-09T21:00:00.000Z")),
  },
  error: {
    provenance: "synthetic-edge",
    vm: unavailableRuntimeOpsSnapshot(new Date("2026-07-09T21:00:00.000Z")),
  },
};
