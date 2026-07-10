import { describe, expect, it, vi } from "vitest";
import type { LoggedEvent } from "../../src/activity/logStore.js";
import type { SessionRecord } from "../../src/resume/SessionLedger.js";
import { RuntimeOpsSnapshotService } from "../../src/runtimeOps/snapshotService.js";

describe("RuntimeOpsSnapshotService", () => {
  it("preserves cumulative and delta semantics while observing activity timestamps and versions", async () => {
    const detector = vi.fn(async () => ["codex", "codex"]);
    const service = new RuntimeOpsSnapshotService(() => [workspace("/private/one/app", "ws-one", "app", [
      ["cx", record("codex")],
      ["cl", record("claude")],
    ])], {
      detect: detector,
      now: () => Date.parse("2026-07-09T21:30:00.000Z"),
      readEvents: (_root, agent) => agent === "cx" ? [
        event("usage.updated", "2026-07-09T20:00:00.000Z", { inputTokens: 1000, outputTokens: 100 }, "0.55"),
        event("usage.updated", "2026-07-09T21:00:00.000Z", { inputTokens: 3000, outputTokens: 200 }, "0.56"),
      ] : [
        event("usage.updated", "2026-07-09T20:30:00.000Z", { inputTokens: 100, outputTokens: 10 }),
        event("usage.updated", "2026-07-09T21:10:00.000Z", { inputTokens: 200, outputTokens: 20 }),
      ],
    });

    const snapshot = await service.snapshot();
    const codex = snapshot.runtimes.find((row) => row.runtime === "codex")!;
    const claude = snapshot.runtimes.find((row) => row.runtime === "claude")!;
    expect(codex.usage).toMatchObject({ state: "available", value: { inputTokens: 3000, outputTokens: 200, semantics: "latest-cumulative" } });
    expect(codex.version).toMatchObject({ state: "available", value: "0.56", observedAt: "2026-07-09T21:00:00.000Z" });
    expect(claude.usage).toMatchObject({ state: "available", value: { inputTokens: 300, outputTokens: 30, semantics: "summed-deltas" } });
    expect(claude.lastActivity).toMatchObject({ state: "available", value: "2026-07-09T21:10:00.000Z" });
    expect(JSON.stringify(snapshot)).not.toContain("/private/one/app");
  });

  it("caches PATH detection for 60 seconds, coalesces reads, and supports manual invalidation", async () => {
    let now = 1_000;
    let resolveDetection: ((value: string[]) => void) | undefined;
    const detector = vi.fn(() => new Promise<string[]>((resolve) => { resolveDetection = resolve; }));
    const service = new RuntimeOpsSnapshotService(() => [], { detect: detector, now: () => now });

    const first = service.snapshot();
    const concurrent = service.snapshot();
    expect(detector).toHaveBeenCalledTimes(1);
    resolveDetection?.(["grok", "grok"]);
    await Promise.all([first, concurrent]);

    await service.snapshot();
    expect(detector).toHaveBeenCalledTimes(1);
    now += 60_001;
    const expired = service.snapshot();
    resolveDetection?.(["codex"]);
    await expired;
    expect(detector).toHaveBeenCalledTimes(2);

    service.invalidateDetection();
    const invalidated = service.snapshot();
    resolveDetection?.(["claude"]);
    await invalidated;
    expect(detector).toHaveBeenCalledTimes(3);
  });
});

function workspace(root: string, wsHash: string, folderName: string, sessions: Array<[string, SessionRecord]>) {
  return { workspaceRoot: root, wsHash, folderName, ledger: { all: () => new Map(sessions) } };
}

function record(runtime: "codex" | "claude"): SessionRecord {
  return { cwd: "/work", declared: true, updatedAt: "2026-07-09T20:00:00.000Z", resume: { runtime, sessionId: "secret-session" } };
}

function event(type: string, timestamp: string, payload: unknown, runtimeVersion?: string): LoggedEvent {
  return {
    schemaVersion: 1,
    type,
    timestamp,
    payload,
    source: { runtime: "test", sessionId: "secret-session", sourcePath: "/private/transcript" },
    loggedAt: timestamp,
    ...(runtimeVersion ? { runtimeVersion } : {}),
  };
}
