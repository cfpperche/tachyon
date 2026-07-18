import { describe, expect, it, vi } from "vitest";
import type { LoggedEvent } from "../../src/activity/logStore.js";
import type { SessionRecord } from "../../src/resume/SessionLedger.js";
import type { RuntimeOpsProviderObservationSnapshotInput } from "../../src/runtimeOps/providerProjection.js";
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
      activityLog: (_root, agent) => staticActivityLog(agent === "cx" ? [
        event("usage.updated", "2026-07-09T20:00:00.000Z", { inputTokens: 1000, outputTokens: 100 }, "0.55"),
        event("usage.updated", "2026-07-09T21:00:00.000Z", { inputTokens: 3000, outputTokens: 200 }, "0.56"),
      ] : [
        event("usage.updated", "2026-07-09T20:30:00.000Z", { inputTokens: 100, outputTokens: 10 }),
        event("usage.updated", "2026-07-09T21:10:00.000Z", { inputTokens: 200, outputTokens: 20 }),
      ]),
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

  it("projects lifecycle, model, resume, throttle, and Bridge state without serializing matchedLine", async () => {
    const root = "/private/runtime-ops";
    const session = record("codex");
    const source = workspace(root, "ws", "app", [["worker", session]]) as ReturnType<typeof workspace> & Record<string, unknown>;
    source.manager = {
      list: async () => [{ name: "worker", session: "private-tmux", running: true, declared: true, dead: false, crashed: false, kind: "agent" }],
      defOf: () => ({ cmd: "codex --model gpt-5.1-codex" }),
      resumeReadiness: async () => true,
    };
    source.attentionOf = () => ({
      state: "throttled", since: 1, contentSince: 1, outputStableSince: 1, episodeKey: "e",
      matchedLine: "RAW_MATCHED_LINE_MUST_NOT_RENDER",
      rateLimit: { runtime: "codex", scope: "5h", resetAt: 12345 },
      stalled: false, awaitingHuman: false, unseen: false, composerOccupied: false, stale: true,
    });
    source.runtimeOpsBridgeHealth = () => ({ currentGeneration: 4, boundGeneration: 4, wired: true, clientState: "ok" });
    const service = new RuntimeOpsSnapshotService(() => [source as never], { detect: async () => ["codex"], activityLog: () => staticActivityLog([]) });

    const snapshot = await service.snapshot();
    const agent = snapshot.runtimes[0].agents[0];
    expect(agent).toMatchObject({
      status: "running",
      attention: { state: "throttled", stale: true, rateLimit: { runtime: "codex", scope: "5h", resetAt: 12345 } },
      model: { state: "available", value: "GPT-5.1 Codex", source: "command" },
      resume: { state: "live" },
      bridge: { state: "ok", currentGeneration: 4, boundGeneration: 4 },
      contextPressure: { state: "unavailable" },
    });
    const serialized = JSON.stringify(snapshot);
    for (const marker of ["RAW_MATCHED_LINE_MUST_NOT_RENDER", "private-tmux", "secret-session", "/private/runtime-ops"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("distinguishes a stopped resumable session from fresh-start-only", async () => {
    const source = workspace("/workspace", "ws", "app", [["stopped", record("claude")]]) as ReturnType<typeof workspace> & Record<string, unknown>;
    source.manager = {
      list: async () => [{ name: "stopped", session: "pane", running: false, declared: true, dead: false, crashed: false, kind: "agent" }],
      defOf: () => ({ cmd: "claude" }),
      resumeReadiness: async () => false,
    };
    const service = new RuntimeOpsSnapshotService(() => [source as never], { detect: async () => [], activityLog: () => staticActivityLog([]) });
    const snapshot = await service.snapshot();
    expect(snapshot.runtimes[0].agents[0]).toMatchObject({
      status: "stopped",
      resume: { state: "fresh-start-only" },
    });
  });

  it("excludes a terminal entry even when its durable ledger row has an adapter runtime", async () => {
    const terminal = { ...record("claude"), def: { cmd: "claude", kind: "terminal" as const } };
    const source = workspace("/workspace", "ws", "app", [["server", terminal]]) as ReturnType<typeof workspace> & Record<string, unknown>;
    source.manager = {
      list: async () => [{ name: "server", session: "server-pane", running: true, declared: true, dead: false, crashed: false, kind: "terminal" }],
      defOf: () => ({ cmd: "claude" }),
      resumeReadiness: async () => true,
    };
    const service = new RuntimeOpsSnapshotService(() => [source as never], { detect: async () => [], activityLog: () => staticActivityLog([]) });

    expect((await service.snapshot()).summary.managedAgents).toBe(0);
  });

  it("hydrates a bounded tail once, then consumes only forward appends on later snapshots", async () => {
    const initial = [event("usage.updated", "2026-07-09T20:00:00.000Z", { inputTokens: 100, outputTokens: 10 })];
    let forwardEvents: LoggedEvent[] = [];
    let tailCalls = 0;
    let forwardCalls = 0;
    let offset = 10;
    const log = {
      tailFrom: () => {
        tailCalls += 1;
        return { events: initial, offset, partial: Buffer.alloc(0) };
      },
      forwardFrom: () => {
        forwardCalls += 1;
        const events = forwardEvents;
        forwardEvents = [];
        offset += events.length;
        return { events, offset, partial: Buffer.alloc(0) };
      },
      size: () => offset + forwardEvents.length,
    };
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["claude", record("claude")]])], {
      detect: async () => [],
      activityLog: () => log,
    });

    expect((await service.snapshot()).runtimes[0].usage).toMatchObject({ value: { inputTokens: 100, outputTokens: 10 } });
    forwardEvents = [event("usage.updated", "2026-07-09T21:00:00.000Z", { inputTokens: 25, outputTokens: 5 })];
    expect((await service.snapshot()).runtimes[0].usage).toMatchObject({ value: { inputTokens: 125, outputTokens: 15 } });
    await service.snapshot();

    expect(tailCalls).toBe(1);
    expect(forwardCalls).toBe(2);
  });

  it("replaces a Codex cumulative snapshot when usage arrives through forwardFrom", async () => {
    const initial = [event("usage.updated", "2026-07-09T20:00:00.000Z", { inputTokens: 100, outputTokens: 10 })];
    let forwardEvents: LoggedEvent[] = [];
    let offset = 10;
    const log = {
      tailFrom: () => ({ events: initial, offset, partial: Buffer.alloc(0) }),
      forwardFrom: (_nextOffset: number, partial: Buffer) => {
        const events = forwardEvents;
        forwardEvents = [];
        offset += events.length;
        return { events, offset, partial };
      },
      size: () => offset + forwardEvents.length,
    };
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["codex", record("codex")]])], {
      detect: async () => [],
      activityLog: () => log,
    });

    expect((await service.snapshot()).runtimes[0].usage).toMatchObject({ value: { inputTokens: 100, outputTokens: 10 } });
    forwardEvents = [event("usage.updated", "2026-07-09T21:00:00.000Z", { inputTokens: 25, outputTokens: 5 })];
    expect((await service.snapshot()).runtimes[0].usage).toMatchObject({ value: { inputTokens: 25, outputTokens: 5, semantics: "latest-cumulative" } });
  });

  it("rehydrates the projection when its durable activity log is truncated", async () => {
    let truncated = false;
    let tailCalls = 0;
    const log = {
      tailFrom: () => {
        tailCalls += 1;
        return truncated
          ? { events: [event("usage.updated", "2026-07-09T21:00:00.000Z", { inputTokens: 7, outputTokens: 3 })], offset: 1, partial: Buffer.alloc(0) }
          : { events: [event("usage.updated", "2026-07-09T20:00:00.000Z", { inputTokens: 100, outputTokens: 10 })], offset: 10, partial: Buffer.alloc(0) };
      },
      forwardFrom: (offset: number, partial: Buffer) => ({ events: [], offset, partial }),
      size: () => truncated ? 1 : 10,
    };
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["claude", record("claude")]])], {
      detect: async () => [],
      activityLog: () => log,
    });

    await service.snapshot();
    truncated = true;
    expect((await service.snapshot()).runtimes[0].usage).toMatchObject({ value: { inputTokens: 7, outputTokens: 3 } });
    expect(tailCalls).toBe(2);
  });

  it("drops an activity projection when its agent disappears from the workspace", async () => {
    let sessions = new Map<string, SessionRecord>([["claude", record("claude")]]);
    let logsCreated = 0;
    const source = {
      workspaceRoot: "/workspace",
      wsHash: "ws",
      folderName: "app",
      ledger: { all: () => sessions },
    };
    const service = new RuntimeOpsSnapshotService(() => [source], {
      detect: async () => [],
      activityLog: () => {
        logsCreated += 1;
        return staticActivityLog([event("usage.updated", "2026-07-09T20:00:00.000Z", { inputTokens: 1, outputTokens: 1 })]);
      },
    });

    await service.snapshot();
    sessions = new Map();
    expect((await service.snapshot()).summary.managedAgents).toBe(0);
    sessions = new Map([["claude", record("claude")]]);
    await service.snapshot();

    expect(logsCreated).toBe(2);
  });

  it("projects only the injected cached provider state and does not couple it to agent count", async () => {
    const providerState: RuntimeOpsProviderObservationSnapshotInput = {
      preferences: {
        codex: {
          scope: { kind: "provider-account", provider: "codex", key: "ps_1111111111111111" },
          sources: ["cli"],
        },
      },
      observations: {
        codex: {
          schemaVersion: 1,
          collector: { id: "tachyon-codex-test", version: "1.0.0" },
          generatedAt: "2026-07-09T21:00:00.000Z",
          facts: [{
            kind: "provider-quota",
            scope: { kind: "provider-account", provider: "codex", key: "ps_1111111111111111" },
            source: "cli",
            confidence: "exact",
            observedAt: "2026-07-09T20:59:00.000Z",
            freshness: { state: "fresh" },
            windows: [{ name: "session", usedPercent: 12 }],
          }],
          diagnostics: [],
        },
      },
    };
    const cachedProviderState = vi.fn(() => providerState);
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [
      ["one", record("codex")],
      ["two", record("codex")],
    ])], {
      detect: async () => [],
      activityLog: () => staticActivityLog([]),
      providerObservations: cachedProviderState,
    });

    const first = await service.snapshot();
    const second = await service.snapshot();
    expect(first.providerCapacity[0].quota).toMatchObject({ state: "available", windows: [{ usedPercent: 12 }] });
    expect(second.summary.managedAgents).toBe(2);
    expect(cachedProviderState).toHaveBeenCalledTimes(2);
  });

  it("keeps native inventory available when the cached provider accessor fails", async () => {
    const service = new RuntimeOpsSnapshotService(() => [], {
      detect: async () => ["codex"],
      now: () => Date.parse("2026-07-09T21:00:00.000Z"),
      providerObservations: () => { throw new Error("RAW_PROVIDER_FAILURE_MUST_NOT_CROSS"); },
    });

    const snapshot = await service.snapshot();
    expect(snapshot.runtimes.map((runtime) => runtime.runtime)).toEqual(["codex"]);
    expect(snapshot.providerCapacity[0]).toMatchObject({
      configuration: { state: "disabled" },
      quota: { state: "unavailable", reason: "source-disabled" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("RAW_PROVIDER_FAILURE_MUST_NOT_CROSS");
  });
});

describe("RuntimeOpsSnapshotService — spec 378 observed model latch", () => {
  const boundary = (timestamp: string, reason: string, runtime = "codex"): LoggedEvent => ({
    schemaVersion: 1,
    type: "session.boundary",
    timestamp,
    payload: { toSession: "s2", reason },
    source: { runtime, sessionId: "s2", sourcePath: "/private/transcript" },
    loggedAt: timestamp,
  });
  const modelEvent = (timestamp: string, model: string, effort?: string, runtime = "codex"): LoggedEvent => ({
    schemaVersion: 1,
    type: "assistant.message.completed",
    timestamp,
    payload: { text: "x" },
    source: { runtime, sessionId: "s1", sourcePath: "/private/transcript" },
    loggedAt: timestamp,
    model,
    ...(effort ? { effort } : {}),
  });

  it("latches in LOG APPEND ORDER, not an observedAt compare (a later-in-log event with an EARLIER timestamp still wins)", async () => {
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["worker", record("codex")]])], {
      detect: async () => [],
      activityLog: () => staticActivityLog([
        modelEvent("2026-07-09T21:00:00.000Z", "gpt-5.5"), // later clock time, EARLIER in the log
        modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.6-sol"), // earlier clock time, LATER in the log — must win
      ]),
    });
    expect(service.observedModelFor("/workspace", "ws", "worker")).toMatchObject({ id: "gpt-5.6-sol" });
  });

  it("a process-ROTATING boundary (restarted/started/forked) fully demotes the observed model", async () => {
    for (const reason of ["restarted", "started", "forked"]) {
      const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["worker", record("codex")]])], {
        detect: async () => [],
        activityLog: () => staticActivityLog([
          modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.6-sol"),
          boundary("2026-07-09T20:00:00.000Z", reason),
        ]),
      });
      expect(service.observedModelFor("/workspace", "ws", "worker")).toBeUndefined();
    }
  });

  it("a process-PRESERVING boundary (in-TUI /clear = 'new', 'resumed', or a t-9f2641 rotation-follow) keeps the observation but flags it stale", async () => {
    for (const reason of ["new", "resumed", "resume", "rotation-follow"]) {
      const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["worker", record("codex")]])], {
        detect: async () => [],
        activityLog: () => staticActivityLog([
          modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.6-sol"),
          boundary("2026-07-09T20:00:00.000Z", reason),
        ]),
      });
      expect(service.observedModelFor("/workspace", "ws", "worker")).toMatchObject({ id: "gpt-5.6-sol", stale: true });
    }
  });

  it("a fresh observation AFTER a boundary in the same batch re-latches and clears staleness (append order)", async () => {
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["worker", record("codex")]])], {
      detect: async () => [],
      activityLog: () => staticActivityLog([
        modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.5"),
        boundary("2026-07-09T20:00:00.000Z", "new"),
        modelEvent("2026-07-09T20:00:05.000Z", "gpt-5.6-sol"),
      ]),
    });
    expect(service.observedModelFor("/workspace", "ws", "worker")).toEqual({
      id: "gpt-5.6-sol", effort: undefined, observedAt: "2026-07-09T20:00:05.000Z", stale: false,
    });
  });

  it("carries effort alongside model", async () => {
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["worker", record("codex")]])], {
      detect: async () => [],
      activityLog: () => staticActivityLog([modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.6-sol", "high")]),
    });
    expect(service.observedModelFor("/workspace", "ws", "worker")).toMatchObject({ id: "gpt-5.6-sol", effort: "high" });
  });

  it("regression (spec 378): the sidebar's view-independent accessor reflects a new observation WITHOUT ever calling snapshot() — RuntimeOps view never opened", async () => {
    let events: LoggedEvent[] = [modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.5")];
    let offset = 1;
    const log = {
      tailFrom: () => ({ events, offset, partial: Buffer.alloc(0) }),
      forwardFrom: (_nextOffset: number, partial: Buffer) => {
        const appended = events.slice(offset);
        offset += appended.length;
        return { events: appended, offset, partial };
      },
      size: () => offset,
    };
    const service = new RuntimeOpsSnapshotService(() => [workspace("/workspace", "ws", "app", [["worker", record("codex")]])], {
      detect: async () => [],
      activityLog: () => log,
    });

    // snapshot() is NEVER called anywhere in this test — only the cheap per-agent accessor is.
    expect(service.observedModelFor("/workspace", "ws", "worker")).toMatchObject({ id: "gpt-5.5" });

    // a model-bearing record lands in the durable log (an activity poll tick) — the accessor alone must see it.
    events = [...events, modelEvent("2026-07-09T19:00:05.000Z", "gpt-5.6-sol")];
    expect(service.observedModelFor("/workspace", "ws", "worker")).toMatchObject({ id: "gpt-5.6-sol" });
  });

  it("the view-independent accessor advances the SAME cursor snapshot() uses (no double-ingest, no separate tailer)", async () => {
    let events: LoggedEvent[] = [modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.5")];
    let offset = 1;
    let tailCalls = 0;
    const log = {
      tailFrom: () => { tailCalls++; return { events, offset, partial: Buffer.alloc(0) }; },
      forwardFrom: (_nextOffset: number, partial: Buffer) => {
        const appended = events.slice(offset);
        offset += appended.length;
        return { events: appended, offset, partial };
      },
      size: () => offset,
    };
    const source = workspace("/workspace", "ws", "app", [["worker", record("codex")]]) as ReturnType<typeof workspace> & Record<string, unknown>;
    source.manager = {
      list: async () => [{ name: "worker", session: "pane", running: true, declared: true, dead: false, crashed: false, kind: "agent" }],
      defOf: () => ({ cmd: "codex" }),
      resumeReadiness: async () => true,
    };
    const service = new RuntimeOpsSnapshotService(() => [source as never], {
      detect: async () => [],
      activityLog: () => log,
    });

    expect(service.observedModelFor("/workspace", "ws", "worker")).toMatchObject({ id: "gpt-5.5" });
    events = [...events, modelEvent("2026-07-09T19:00:05.000Z", "gpt-5.6-sol")];
    const snapshot = await service.snapshot();
    expect(snapshot.runtimes[0].agents[0].modelObserved).toMatchObject({ value: "GPT-5.6 Sol" });
    expect(tailCalls).toBe(1); // the second read went through forwardFrom (shared cursor), not a fresh tail
  });

  it("projects divergence in snapshot() when the observed model differs from the declared/profile default", async () => {
    const source = workspace("/workspace", "ws", "app", [["worker", record("codex")]]) as ReturnType<typeof workspace> & Record<string, unknown>;
    source.manager = {
      list: async () => [{ name: "worker", session: "pane", running: true, declared: true, dead: false, crashed: false, kind: "agent" }],
      defOf: () => ({ cmd: "codex" }), // bare codex → declared "Codex default"
      resumeReadiness: async () => true,
    };
    const service = new RuntimeOpsSnapshotService(() => [source as never], {
      detect: async () => [],
      activityLog: () => staticActivityLog([modelEvent("2026-07-09T19:00:00.000Z", "gpt-5.6-sol")]),
    });
    const snapshot = await service.snapshot();
    const agent = snapshot.runtimes[0].agents[0];
    expect(agent.model).toMatchObject({ value: "Codex default" }); // declared/profile column stays declared-only
    expect(agent.modelObserved).toMatchObject({ value: "GPT-5.6 Sol" });
    expect(agent.modelDivergence).toBe(true);
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

function staticActivityLog(events: LoggedEvent[]) {
  return {
    tailFrom: () => ({ events, offset: events.length, partial: Buffer.alloc(0) }),
    forwardFrom: (offset: number, partial: Buffer) => ({ events: [], offset, partial }),
    size: () => events.length,
  };
}
