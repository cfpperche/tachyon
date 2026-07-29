/**
 * spec 364 — Bridge-client rebind coordinator unit tests.
 * Covers generation, durable stamp reconstruct, preflight, double-bump, queue, circuit, skip non-wired.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// vi is used for waitFor in the double-bump test only (no fake timers).
import {
  BridgeClientRebindCoordinator,
  DEFAULT_BRIDGE_CLIENT_REBIND,
  bridgeGenerationStateKey,
  isWiredSuspect,
  isTachyonBridgeWiredRecord,
  parseBridgeClientRebindSettings,
  type BridgeClientRebindDeps,
  type BridgeClientRebindSettings,
  type RebindResumeReadiness,
} from "../../src/bridge/clientRebind.js";
import { SessionLedger, durableBoundGeneration, type SessionRecord } from "../../src/resume/SessionLedger.js";
import { parseConfig } from "../../src/config/loadConfig.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-364-"));
}

function baseRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    def: { cmd: "grok", kind: "agent" },
    resume: { runtime: "grok", sessionId: "s1" },
    cwd: "/ws",
    instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true },
    updatedAt: new Date(0).toISOString(),
    ...over,
  };
}

function makeDeps(opts: {
  ledger: Map<string, SessionRecord>;
  running: Set<string>;
  kinds?: Map<string, "agent" | "terminal">;
  settings?: BridgeClientRebindSettings;
  state?: Map<string, unknown>;
  auditPath: string;
  initiator?: string;
  resumeImpl?: (name: string, record: SessionRecord, opts?: { injectPrimer?: boolean; deferBridgeStamp?: boolean }) => Promise<void>;
  canResumeImpl?: (name: string, record: SessionRecord) => Promise<RebindResumeReadiness>;
  resumeDeniedImpl?: (name: string, record: SessionRecord) => boolean;
  stopImpl?: (name: string) => Promise<void>;
  onSleep?: (ms: number) => void;
}): BridgeClientRebindDeps & {
  state: Map<string, unknown>;
  notices: string[];
  notifies: Array<{ m: string; l: string }>;
  expectedDeath: string[];
  resumes: string[];
  resumeOpts: Array<{ name: string; injectPrimer?: boolean; deferBridgeStamp?: boolean }>;
  stops: string[];
  hardKills: string[];
} {
  const state = opts.state ?? new Map<string, unknown>();
  const notices: string[] = [];
  const notifies: Array<{ m: string; l: string }> = [];
  const expectedDeath: string[] = [];
  const resumes: string[] = [];
  const resumeOpts: Array<{ name: string; injectPrimer?: boolean; deferBridgeStamp?: boolean }> = [];
  const stops: string[] = [];
  const hardKills: string[] = [];
  const settings = opts.settings ?? { ...DEFAULT_BRIDGE_CLIENT_REBIND };
  // Virtual clock so stop-timeout waits never busy-spin on wall time.
  let clock = 1_000_000;

  const deps: BridgeClientRebindDeps & {
    state: Map<string, unknown>;
    notices: string[];
    notifies: Array<{ m: string; l: string }>;
    expectedDeath: string[];
    resumes: string[];
    resumeOpts: Array<{ name: string; injectPrimer?: boolean; deferBridgeStamp?: boolean }>;
    stops: string[];
    hardKills: string[];
  } = {
    workspaceHash: "abcd1234",
    bridgeInstanceId: "inst01",
    state,
    notices,
    notifies,
    expectedDeath,
    resumes,
    resumeOpts,
    stops,
    hardKills,
    getState: <T>(key: string) => state.get(key) as T | undefined,
    setState: (key, value) => {
      if (value === undefined) state.delete(key);
      else state.set(key, value);
    },
    getLedger: (name) => opts.ledger.get(name),
    listRunning: async () => [...opts.running],
    kindOf: (name) => opts.kinds?.get(name) ?? "agent",
    isRunning: async (name) => opts.running.has(name),
    canResume: (name, record) => opts.canResumeImpl?.(name, record) ?? Promise.resolve({ kind: "ready" as const }),
    resumeDenied: (name, record) => opts.resumeDeniedImpl?.(name, record) ?? record.delivery !== undefined,
    stopGracefully: async (name) => {
      stops.push(name);
      if (opts.stopImpl) await opts.stopImpl(name);
      else opts.running.delete(name);
    },
    hardKillSession: async (name) => {
      hardKills.push(name);
      opts.running.delete(name);
    },
    resume: async (name, record, resumeCallOpts) => {
      resumes.push(name);
      resumeOpts.push({
        name,
        injectPrimer: resumeCallOpts?.injectPrimer,
        deferBridgeStamp: resumeCallOpts?.deferBridgeStamp,
      });
      if (opts.resumeImpl) await opts.resumeImpl(name, record, resumeCallOpts);
      else {
        opts.running.add(name);
        // Default: stamp as coordinator will also stamp — simulate AgentManager resume stamp
        const gen = (state.get(bridgeGenerationStateKey("abcd1234", "inst01")) as number) ?? 0;
        opts.ledger.set(name, {
          ...record,
          ...(resumeCallOpts?.deferBridgeStamp ? {} : { bridgeClient: { boundGeneration: gen, wired: true } }),
          updatedAt: new Date().toISOString(),
        });
      }
    },
    stampBridgeClient: (name, generation) => {
      const rec = opts.ledger.get(name);
      if (!rec) return;
      opts.ledger.set(name, {
        ...rec,
        bridgeClient: { boundGeneration: generation, wired: true },
        updatedAt: new Date().toISOString(),
      });
    },
    markExpectedDeath: (name) => {
      expectedDeath.push(name);
    },
    notify: (m, l) => {
      notifies.push({ m, l });
    },
    deliverNotice: async (name, line) => {
      notices.push(`${name}:${line}`);
    },
    getSettings: () => settings,
    auditPath: opts.auditPath,
    getReloadInitiator: () => opts.initiator,
    clearReloadInitiator: () => {
      state.delete(`tachyon.bridgeClient.reloadInitiator.abcd1234`);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      opts.onSleep?.(ms);
    },
  };
  return deps;
}

describe("parseBridgeClientRebindSettings", () => {
  it("returns defaults for missing/invalid", () => {
    expect(parseBridgeClientRebindSettings(undefined)).toEqual(DEFAULT_BRIDGE_CLIENT_REBIND);
    expect(parseBridgeClientRebindSettings({})).toEqual(DEFAULT_BRIDGE_CLIENT_REBIND);
  });

  it("parses overrides", () => {
    expect(
      parseBridgeClientRebindSettings({
        onHostGenerationBump: "notify",
        graceMs: 100,
        stopTimeoutMs: 5000,
        maxConcurrentRebinds: 2,
        circuitFailCount: 5,
      }),
    ).toEqual({
      onHostGenerationBump: "notify",
      graceMs: 100,
      stopTimeoutMs: 5000,
      maxConcurrentRebinds: 2,
      circuitFailCount: 5,
    });
  });
});

describe("loadConfig settings.bridgeClientRebind", () => {
  it("accepts valid section and rejects unknown keys", () => {
    const ok = parseConfig(`
agents:
  a: { cmd: "echo" }
settings:
  bridgeClientRebind:
    onHostGenerationBump: auto
    graceMs: 0
    stopTimeoutMs: 15000
    maxConcurrentRebinds: 1
    circuitFailCount: 3
`);
    expect(ok.errors).toEqual([]);
    expect(ok.config?.settings.bridgeClientRebind).toEqual({
      onHostGenerationBump: "auto",
      graceMs: 0,
      stopTimeoutMs: 15000,
      maxConcurrentRebinds: 1,
      circuitFailCount: 3,
    });

    const bad = parseConfig(`
agents:
  a: { cmd: "echo" }
settings:
  bridgeClientRebind:
    onHostGenerationBump: maybe
    nope: 1
`);
    expect(bad.errors.some((e) => e.includes("onHostGenerationBump"))).toBe(true);
    expect(bad.errors.some((e) => e.includes("unknown key"))).toBe(true);
  });
});

describe("SessionLedger bridgeClient", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("round-trips bridgeClient and treats missing boundGeneration as 0", () => {
    const ws = tmpDir();
    dirs.push(ws);
    const l = new SessionLedger(ws);
    l.record("a", {
      def: { cmd: "grok", kind: "agent" },
      resume: { runtime: "grok", sessionId: "x" },
      cwd: ws,
      instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true },
      bridgeClient: { boundGeneration: 2, wired: true },
    });
    const back = new SessionLedger(ws).get("a");
    expect(back?.bridgeClient).toEqual({ boundGeneration: 2, wired: true });
    expect(durableBoundGeneration(back)).toBe(2);
    expect(durableBoundGeneration(undefined)).toBe(0);
    expect(durableBoundGeneration(baseRecord())).toBe(0);
  });

  it("drops malformed bridgeClient blocks", () => {
    const ws = tmpDir();
    dirs.push(ws);
    const p = path.join(ws, ".tachyon");
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, "sessions.json"),
      JSON.stringify({
        sessions: {
          a: {
            def: { cmd: "grok", kind: "agent" },
            cwd: ws,
            declared: true,
            updatedAt: "t0",
            bridgeClient: { boundGeneration: "nope", wired: true },
          },
        },
      }),
      "utf8",
    );
    expect(new SessionLedger(ws).get("a")?.bridgeClient).toBeUndefined();
  });
});

describe("isWiredSuspect / isTachyonBridgeWiredRecord", () => {
  it("requires wired (or inferred) and boundGeneration < G; absent bound = 0", () => {
    expect(isWiredSuspect(undefined, 1)).toBe(false);
    expect(isWiredSuspect(baseRecord({ bridgeClient: { boundGeneration: 0, wired: false } }), 1)).toBe(false);
    expect(isWiredSuspect(baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } }), 1)).toBe(true);
    expect(isWiredSuspect(baseRecord({ bridgeClient: { boundGeneration: 1, wired: true } }), 1)).toBe(false);
    expect(isWiredSuspect(baseRecord({ bridgeClient: { boundGeneration: 1, wired: true } }), 2)).toBe(true);
    // pre-364 / never-stamped: infer from resume.runtime (grok) — dogfood failure without this
    expect(isTachyonBridgeWiredRecord(baseRecord())).toBe(true);
    expect(isWiredSuspect(baseRecord(), 1)).toBe(true);
    expect(isWiredSuspect(baseRecord({ resume: { runtime: "claude", sessionId: "c1" } }), 1)).toBe(true);
    // shell / non-bridge binary without stamp → not wired
    expect(
      isWiredSuspect(
        baseRecord({
          def: { cmd: "bash", kind: "agent" },
          resume: undefined,
        }),
        1,
      ),
    ).toBe(false);
  });

  it("onListenerReady rebinds never-stamped survivors (inferred wiring)", async () => {
    const auditDir = tmpDir();
    const dirs: string[] = [auditDir];
    try {
      const ledger = new Map<string, SessionRecord>([
        // no bridgeClient stamp — live dogfood shape after installing 364 on old sessions
        ["grok", baseRecord()],
      ]);
      const running = new Set(["grok"]);
      const deps = makeDeps({
        ledger,
        running,
        auditPath: path.join(auditDir, "audit.jsonl"),
      });
      const c = new BridgeClientRebindCoordinator(deps);
      await c.onListenerReady();
      expect(deps.resumes).toContain("grok");
      expect(deps.stops).toContain("grok");
      // after resume stamp
      expect(ledger.get("grok")?.bridgeClient?.wired).toBe(true);
      expect(ledger.get("grok")?.bridgeClient?.boundGeneration).toBe(1);
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("BridgeClientRebindCoordinator", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reload-safe: refuses an unsafe Delivery resume before every teardown side effect", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["delivery-worker", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["delivery-worker"]);
    const auditPath = path.join(auditDir, "delivery.jsonl");
    let probes = 0;
    let sleepsAfterProbe = 0;
    const deps = makeDeps({
      ledger,
      running,
      auditPath,
      canResumeImpl: async () => {
        probes++;
        return { kind: "denied", reason: "Delivery-owned execution" };
      },
      onSleep: () => {
        if (probes > 0) sleepsAfterProbe++;
      },
    });

    const coordinator = new BridgeClientRebindCoordinator(deps);
    await coordinator.onListenerReady();

    expect(running.has("delivery-worker")).toBe(true);
    expect(deps.expectedDeath).toEqual([]);
    expect(deps.stops).toEqual([]);
    expect(deps.hardKills).toEqual([]);
    expect(deps.resumes).toEqual([]);
    expect(ledger.get("delivery-worker")?.bridgeClient?.boundGeneration).toBe(0);
    expect(probes).toBe(1);
    expect(sleepsAfterProbe).toBe(0);
    expect(fs.readFileSync(auditPath, "utf8")).toContain("Delivery-owned execution");
  });

  it("388: waits for transient readiness, then resumes the same session without early teardown", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const auditPath = path.join(auditDir, "transient-ready.jsonl");
    const sessionId = "codex-session-stable";
    const record = baseRecord({
      def: { cmd: "codex", kind: "agent" },
      resume: { runtime: "codex", sessionId },
      bridgeClient: { boundGeneration: 0, wired: true },
    });
    const ledger = new Map([["codex", record]]);
    const running = new Set(["codex"]);
    const probedRecords: SessionRecord[] = [];
    const resumedSessionIds: string[] = [];
    let readinessSleeps = 0;
    let teardownObservedBeforeReady = false;
    let deps!: ReturnType<typeof makeDeps>;
    deps = makeDeps({
      ledger,
      running,
      auditPath,
      canResumeImpl: async (_name, current) => {
        probedRecords.push(current);
        if (probedRecords.length === 1) return { kind: "retry", reason: "transcript not ready" };
        return { kind: "ready" };
      },
      onSleep: () => {
        if (probedRecords.length !== 1) return;
        readinessSleeps++;
        teardownObservedBeforeReady ||= deps.expectedDeath.length > 0
          || deps.stops.length > 0
          || deps.hardKills.length > 0
          || deps.resumes.length > 0;
      },
      resumeImpl: async (name, current) => {
        resumedSessionIds.push(current.resume?.sessionId ?? "");
        running.add(name);
      },
    });

    const coordinator = new BridgeClientRebindCoordinator(deps);
    await coordinator.onListenerReady();

    expect(probedRecords).toHaveLength(2);
    expect(probedRecords[0]).toBe(record);
    expect(probedRecords[1]).toBe(record);
    expect(readinessSleeps).toBeGreaterThan(0);
    expect(teardownObservedBeforeReady).toBe(false);
    expect(deps.expectedDeath).toEqual(["codex"]);
    expect(deps.stops).toEqual(["codex"]);
    expect(deps.hardKills).toEqual([]);
    expect(deps.resumes).toEqual(["codex"]);
    expect(resumedSessionIds).toEqual([sessionId]);
    expect(running.has("codex")).toBe(true);
    expect(ledger.get("codex")?.resume?.sessionId).toBe(sessionId);
    expect(ledger.get("codex")?.bridgeClient?.boundGeneration).toBe(1);

    const phases = fs.readFileSync(auditPath, "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { phase: string }).phase);
    expect(phases).toEqual(expect.arrayContaining(["preflight_wait", "preflight_ok", "resume_ok"]));
    expect(phases.indexOf("preflight_wait")).toBeLessThan(phases.indexOf("preflight_ok"));
    expect(phases.indexOf("preflight_ok")).toBeLessThan(phases.indexOf("resume_ok"));
  });

  it("388: a final authority denial after positive readiness prevents every teardown side effect", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const auditPath = path.join(auditDir, "late-authority-denial.jsonl");
    const ledger = new Map([["codex", baseRecord({
      def: { cmd: "codex", kind: "agent" },
      resume: { runtime: "codex", sessionId: "codex-session-authority-race" },
      bridgeClient: { boundGeneration: 0, wired: true },
    })]]);
    const running = new Set(["codex"]);
    let authorityChecks = 0;
    let denied = false;
    const deps = makeDeps({
      ledger,
      running,
      auditPath,
      canResumeImpl: async () => ({ kind: "ready" }),
      resumeDeniedImpl: () => {
        authorityChecks++;
        if (authorityChecks === 2) {
          // Simulate the crash-window authority snapshot changing immediately after the last
          // awaited liveness/readiness preflight, before teardown admission.
          denied = true;
          return false;
        }
        return denied;
      },
    });

    const coordinator = new BridgeClientRebindCoordinator(deps);
    await coordinator.onListenerReady();

    expect(authorityChecks).toBe(3);
    expect(running.has("codex")).toBe(true);
    expect(coordinator.getClientState("codex")).toBe("failed");
    expect(deps.expectedDeath).toEqual([]);
    expect(deps.stops).toEqual([]);
    expect(deps.hardKills).toEqual([]);
    expect(deps.resumes).toEqual([]);
    expect(fs.readFileSync(auditPath, "utf8")).toContain("generic resume became denied before teardown");
  });

  it("388: bounded readiness timeout leaves the original process running with zero teardown", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const auditPath = path.join(auditDir, "transient-timeout.jsonl");
    const ledger = new Map([["codex", baseRecord({
      def: { cmd: "codex", kind: "agent" },
      resume: { runtime: "codex", sessionId: "codex-session-timeout" },
      bridgeClient: { boundGeneration: 0, wired: true },
    })]]);
    const running = new Set(["codex"]);
    let probes = 0;
    const deps = makeDeps({
      ledger,
      running,
      auditPath,
      canResumeImpl: async () => {
        probes++;
        return { kind: "retry", reason: "transcript not ready" };
      },
    });

    const coordinator = new BridgeClientRebindCoordinator(deps);
    await coordinator.onListenerReady();

    expect(probes).toBeGreaterThan(1);
    expect(probes).toBeLessThanOrEqual(52);
    expect(running.has("codex")).toBe(true);
    expect(coordinator.getClientState("codex")).toBe("failed");
    expect(deps.expectedDeath).toEqual([]);
    expect(deps.stops).toEqual([]);
    expect(deps.hardKills).toEqual([]);
    expect(deps.resumes).toEqual([]);
    expect(ledger.get("codex")?.bridgeClient?.boundGeneration).toBe(0);

    const audit = fs.readFileSync(auditPath, "utf8");
    expect(audit).toContain('"phase":"preflight_wait"');
    expect(audit).toContain('"phase":"preflight_timeout"');
    expect(audit).toContain("transcript not ready");
  });

  it("reload-safe: rescans a wired survivor that appears only after host inventory settles", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["late-codex", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set<string>();
    let inventorySettled = false;
    const deps = makeDeps({
      ledger,
      running,
      auditPath: path.join(auditDir, "late-inventory.jsonl"),
      onSleep: () => {
        if (!inventorySettled) {
          inventorySettled = true;
          running.add("late-codex");
        }
      },
    });

    const coordinator = new BridgeClientRebindCoordinator(deps);
    await coordinator.onListenerReady();

    expect(inventorySettled).toBe(true);
    expect(deps.expectedDeath).toEqual(["late-codex"]);
    expect(deps.stops).toEqual(["late-codex"]);
    expect(deps.resumes).toEqual(["late-codex"]);
    expect(ledger.get("late-codex")?.bridgeClient?.boundGeneration).toBe(1);
  });

  it("reload-safe: replacement death inside the stability window is resume_fail, never resume_ok", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["reviewer", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["reviewer"]);
    let replacementStarted = false;
    const auditPath = path.join(auditDir, "early-exit.jsonl");
    const deps = makeDeps({
      ledger,
      running,
      auditPath,
      canResumeImpl: async () => ({ kind: "ready" }),
      resumeImpl: async (name) => {
        replacementStarted = true;
        running.add(name);
      },
      onSleep: () => {
        if (replacementStarted) running.delete("reviewer");
      },
    });
    const coordinator = new BridgeClientRebindCoordinator(deps);
    await coordinator.onListenerReady();

    const audit = fs.readFileSync(auditPath, "utf8");
    expect(coordinator.getClientState("reviewer")).toBe("failed");
    expect(audit).toContain('"phase":"resume_fail"');
    expect(audit).not.toContain('"phase":"resume_ok"');
    expect(ledger.get("reviewer")?.bridgeClient?.boundGeneration).toBe(0);
    expect(deps.notifies.some(({ m, l }) => l === "error" && m.includes("post-resume stability window"))).toBe(true);
  });

  it("bumps generation once per onListenerReady and reconstructs suspects after reload", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map<string, SessionRecord>([
      ["grok", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })],
      ["shell", baseRecord({ def: { cmd: "sh", kind: "terminal" }, bridgeClient: { boundGeneration: 0, wired: true } })],
      // non-Bridge agent (no stamp, no tachyon-bridge runtime) — must not rebind
      ["unwired", baseRecord({ def: { cmd: "python3 -m http.server", kind: "agent" }, resume: undefined })],
    ]);
    const running = new Set(["grok", "shell", "unwired"]);
    const deps = makeDeps({
      ledger,
      running,
      kinds: new Map([
        ["grok", "agent"],
        ["shell", "terminal"],
        ["unwired", "agent"],
      ]),
      auditPath: path.join(auditDir, "audit.jsonl"),
    });

    const c1 = new BridgeClientRebindCoordinator(deps);
    await c1.onListenerReady();
    expect(c1.getGeneration()).toBe(1);
    // auto rebind should have stop+resumed grok
    expect(deps.stops).toContain("grok");
    expect(deps.resumes).toContain("grok");
    expect(deps.stops).not.toContain("shell");
    expect(deps.stops).not.toContain("unwired");
    expect(deps.expectedDeath).toContain("grok");
    expect(ledger.get("grok")?.bridgeClient?.boundGeneration).toBe(1);
    expect(c1.getClientState("grok")).toBe("ok");

    // Simulate reload: new coordinator, same host state + ledger (already stamped 1)
    const c2 = new BridgeClientRebindCoordinator(deps);
    // Manually set bound back to 0 as if pre-rebind survivor, generation still 1 in host state
    // After another listener ready, gen → 2, rebind again
    ledger.set("grok", baseRecord({ bridgeClient: { boundGeneration: 1, wired: true } }));
    running.add("grok");
    deps.stops.length = 0;
    deps.resumes.length = 0;
    await c2.onListenerReady();
    expect(c2.getGeneration()).toBe(2);
    expect(deps.resumes).toContain("grok");
    expect(ledger.get("grok")?.bridgeClient?.boundGeneration).toBe(2);

    // Audit trail present
    const audit = fs.readFileSync(path.join(auditDir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((l) => l.includes("resume_ok"))).toBe(true);
  });

  it("t-762940: rebind resume always passes injectPrimer:false (no primer paste after host reload)", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["grok", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["grok"]);
    const deps = makeDeps({
      ledger,
      running,
      auditPath: path.join(auditDir, "primer.jsonl"),
    });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();
    expect(deps.resumes).toEqual(["grok"]);
    expect(deps.resumeOpts).toEqual([{ name: "grok", injectPrimer: false, deferBridgeStamp: true }]);
  });

  it("policy off does not bump or rebind", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    const deps = makeDeps({
      ledger,
      running,
      settings: { ...DEFAULT_BRIDGE_CLIENT_REBIND, onHostGenerationBump: "off" },
      auditPath: path.join(auditDir, "a.jsonl"),
    });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();
    expect(c.getGeneration()).toBe(0);
    expect(deps.stops).toEqual([]);
  });

  it("policy notify marks but does not stop/resume", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    const deps = makeDeps({
      ledger,
      running,
      settings: { ...DEFAULT_BRIDGE_CLIENT_REBIND, onHostGenerationBump: "notify" },
      auditPath: path.join(auditDir, "n.jsonl"),
    });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();
    expect(c.getGeneration()).toBe(1);
    expect(c.getClientState("a")).toBe("suspect");
    expect(deps.stops).toEqual([]);
    expect(deps.notifies.some((n) => n.m.includes("notify"))).toBe(true);
  });

  it("preflight skips user-stopped agent (cancelled, never resume)", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    const deps = makeDeps({
      ledger,
      running,
      // Short real grace so we can cancel while still suspect/queued without fake timers.
      settings: { ...DEFAULT_BRIDGE_CLIENT_REBIND, graceMs: 40 },
      auditPath: path.join(auditDir, "u.jsonl"),
    });
    const c = new BridgeClientRebindCoordinator(deps);
    const ready = c.onListenerReady();
    await new Promise((r) => setTimeout(r, 5));
    expect(c.getClientState("a")).toBe("suspect");
    running.delete("a");
    c.onAgentStopped("a");
    expect(c.getClientState("a")).toBe("cancelled");
    await ready;
    expect(deps.resumes).toEqual([]);
    c.onNewIncarnation("a");
    expect(c.getClientState("a")).toBe("ok");
  });

  it("preflight skips when manual resume already stamped current generation", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    const deps = makeDeps({
      ledger,
      running,
      settings: { ...DEFAULT_BRIDGE_CLIENT_REBIND, graceMs: 40 },
      auditPath: path.join(auditDir, "h.jsonl"),
    });
    const c = new BridgeClientRebindCoordinator(deps);
    const p = c.onListenerReady();
    await new Promise((r) => setTimeout(r, 5));
    // Human (or sidebar) resume healed before grace elapsed — stamp current generation.
    ledger.set("a", baseRecord({ bridgeClient: { boundGeneration: c.getGeneration(), wired: true } }));
    await p;
    expect(deps.resumes).toEqual([]);
    expect(deps.stops).toEqual([]);
    expect(c.getClientState("a")).toBe("ok");
  });

  it("double-bump while rebinding sets pending_recheck and stamps current gen", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    let resumeGate: (() => void) | undefined;
    let coordinator: BridgeClientRebindCoordinator | undefined;
    let stateInsideResume: string | undefined;
    const resumeBlocked = new Promise<void>((r) => {
      resumeGate = r;
    });
    const deps = makeDeps({
      ledger,
      running,
      auditPath: path.join(auditDir, "d.jsonl"),
      resumeImpl: async (name, record) => {
        await resumeBlocked;
        running.add(name);
        coordinator?.onNewIncarnation(name);
        stateInsideResume = coordinator?.getClientState(name);
        const gen = (deps.state.get(bridgeGenerationStateKey("abcd1234", "inst01")) as number) ?? 0;
        ledger.set(name, {
          ...record,
          bridgeClient: { boundGeneration: gen, wired: true },
          updatedAt: new Date().toISOString(),
        });
      },
      stopImpl: async () => {
        running.delete("a");
      },
    });
    const c = new BridgeClientRebindCoordinator(deps);
    coordinator = c;
    const first = c.onListenerReady();
    // Wait until rebinding started
    await vi.waitFor(() => {
      expect(c.getClientState("a")).toBe("rebinding");
    });
    // Double bump while rebinding
    const marked = await c.markSuspects(c.bumpGeneration());
    expect(marked).toEqual([]); // no second concurrent rebind enqueue from mark (pending_recheck)
    expect(c.getGeneration()).toBe(2);
    resumeGate!();
    await first;
    expect(stateInsideResume).toBe("rebinding");
    // After success, stamp is current gen (2) via stampBridgeClient at end
    expect(ledger.get("a")?.bridgeClient?.boundGeneration).toBe(2);
  });

  it("serializes maxConcurrentRebinds=1 and opens circuit after N failures", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const names = ["a", "b", "c", "d"];
    const ledger = new Map(names.map((n) => [n, baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]));
    const running = new Set(names);
    let concurrent = 0;
    let maxConcurrent = 0;
    const deps = makeDeps({
      ledger,
      running,
      settings: { ...DEFAULT_BRIDGE_CLIENT_REBIND, maxConcurrentRebinds: 1, circuitFailCount: 3 },
      auditPath: path.join(auditDir, "c.jsonl"),
      resumeImpl: async (name) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        concurrent--;
        throw new Error(`resume failed for ${name}`);
      },
      stopImpl: async (name) => {
        running.delete(name);
      },
    });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();
    expect(maxConcurrent).toBeLessThanOrEqual(1);
    expect(c.isCircuitOpen()).toBe(true);
    expect(deps.notifies.some((n) => n.m.includes("circuit"))).toBe(true);
    // 4th agent may not have been attempted
    expect(deps.resumes.length).toBe(3);
  });

  it("delivers 359 initiator notice after rebind success", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["orch", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["orch"]);
    const deps = makeDeps({
      ledger,
      running,
      auditPath: path.join(auditDir, "i.jsonl"),
      initiator: "orch",
    });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();
    expect(deps.notices.some((n) => n.startsWith("orch:") && n.includes("rebound"))).toBe(true);
  });

  it("grace clear by authenticated self dequeues", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    const deps = makeDeps({
      ledger,
      running,
      settings: { ...DEFAULT_BRIDGE_CLIENT_REBIND, graceMs: 40 },
      auditPath: path.join(auditDir, "g.jsonl"),
    });
    const c = new BridgeClientRebindCoordinator(deps);
    const p = c.onListenerReady();
    await new Promise((r) => setTimeout(r, 5));
    expect(c.getClientState("a")).toBe("suspect");
    c.onAuthenticatedSelfCall("a");
    expect(c.getClientState("a")).toBe("ok");
    await p;
    expect(deps.resumes).toEqual([]);
  });

  it("resume failure leaves failed, no cold spawn, notifies", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    const deps = makeDeps({
      ledger,
      running,
      auditPath: path.join(auditDir, "f.jsonl"),
      resumeImpl: async () => {
        throw new Error("transcript gone");
      },
      stopImpl: async () => {
        running.delete("a");
      },
    });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();
    expect(c.getClientState("a")).toBe("failed");
    expect(running.has("a")).toBe(false);
    expect(deps.notifies.some((n) => n.l === "error" && n.m.includes("transcript gone"))).toBe(true);
  });

  it("hard-kills when graceful stop does not end the session", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const ledger = new Map([["a", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    const running = new Set(["a"]);
    const deps = makeDeps({
      ledger,
      running,
      settings: { ...DEFAULT_BRIDGE_CLIENT_REBIND, stopTimeoutMs: 50 },
      auditPath: path.join(auditDir, "hk.jsonl"),
      stopImpl: async () => {
        /* ignore graceful — stay running */
      },
    });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();
    expect(deps.hardKills).toContain("a");
    expect(deps.resumes).toContain("a");
  });

  it("t-016e8b: boot scans retry with backoff while the strict inventory is ambiguous, then rebind", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const auditPath = path.join(auditDir, "audit.jsonl");
    const ledger = new Map([
      ["codex", baseRecord({ def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "s1" }, bridgeClient: { boundGeneration: 0, wired: true } })],
    ]);
    const running = new Set(["codex"]);
    const sleeps: number[] = [];
    const deps = makeDeps({ ledger, running, auditPath, onSleep: (ms) => sleeps.push(ms) });
    // A fresh engine process: the cached (non-strict) read is cold-empty, the strict read is
    // ambiguous twice (tmux still settling after the upgrade), then answers with the survivor.
    deps.listRunning = async () => [];
    const strictResults: Array<string[] | null> = [null, null, ["codex"]];
    deps.listRunningStrict = async () => (strictResults.length > 0 ? (strictResults.shift() as string[] | null) : ["codex"]);

    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();

    expect(deps.resumes).toEqual(["codex"]);
    expect(c.getClientState("codex")).toBe("ok");
    const scans = fs.readFileSync(auditPath, "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as { phase: string; agent: string; running?: number | null; marked?: number })
      .filter((e) => e.phase === "scan");
    // initial bump scan + first (100ms) rescan both ambiguous, third scan finds the survivor
    expect(scans.length).toBe(3);
    expect(scans[0]).toMatchObject({ agent: "*", running: null, marked: 0 });
    expect(scans[2]).toMatchObject({ agent: "*", running: 1, marked: 1 });
    expect(sleeps).toContain(1_000); // backoff engaged past the fixed settle
  });

  it("t-016e8b: an all-empty generation bump audits every scan instead of staying silent", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const auditPath = path.join(auditDir, "audit.jsonl");
    const deps = makeDeps({ ledger: new Map(), running: new Set(), auditPath });
    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();

    const scans = fs.readFileSync(auditPath, "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as { phase: string; running?: number | null; marked?: number })
      .filter((e) => e.phase === "scan");
    // initial bump scan + one settle rescan — a CONFIRMED empty inventory ends the backoff
    // early (zero-agent boots are common and must not burn the whole schedule), but both
    // scans still leave audit lines.
    expect(scans.length).toBe(2);
    for (const scan of scans) expect(scan).toMatchObject({ running: 0, marked: 0 });
    expect(deps.resumes).toEqual([]);
  });

  it("t-016e8b: a suspect that exits before enqueue is audited as enqueue_skip, not dropped silently", async () => {
    const auditDir = tmpDir();
    dirs.push(auditDir);
    const auditPath = path.join(auditDir, "audit.jsonl");
    const ledger = new Map([["gone", baseRecord({ bridgeClient: { boundGeneration: 0, wired: true } })]]);
    // Inventory lists the survivor, but it is no longer running by the per-name recheck.
    const deps = makeDeps({ ledger, running: new Set(), auditPath });
    deps.listRunningStrict = async () => ["gone"];

    const c = new BridgeClientRebindCoordinator(deps);
    await c.onListenerReady();

    expect(deps.resumes).toEqual([]);
    expect(c.getClientState("gone")).toBe("cancelled");
    const events = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { phase: string; agent: string; finalState?: string });
    expect(events.some((e) => e.phase === "enqueue_skip" && e.agent === "gone" && e.finalState === "cancelled")).toBe(true);
  });
});
