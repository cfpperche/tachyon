import { describe, expect, it } from "vitest";
import {
  LinuxSystemdProcessFence,
  nonceDigestOf,
  unitNameForDigest,
  posixShellQuote,
  wrapSystemdScopeCommand,
  parseAuditHelperStdout,
  LINUX_PROCESS_FENCE_DOMAIN,
  type AuditHelperPort,
  type AuditHelperRunResult,
  type BootIdentityPort,
  type CgroupEvents,
  type CgroupFsPort,
  type FenceClock,
  type FenceIdentityStore,
  type FenceIdentityV1,
  type HelperBinaryInspection,
  type SystemdUnitSnapshot,
  type SystemdUserPort,
  type LinuxProcessFenceDeps,
} from "../../src/agents/linuxProcessFence.js";
import { UnavailableProcessFence } from "../../src/agents/processFence.js";

// ── Deterministic fake host ────────────────────────────────────────────────

type UnitState = {
  snap: SystemdUnitSnapshot;
  events: CgroupEvents;
  procs: number[];
  freezeWrites: boolean[];
  killWrites: number;
  stopCalls: number;
};

function goodHelperInspection(overrides: Partial<HelperBinaryInspection> = {}): HelperBinaryInspection {
  return {
    path: "/opt/tachyon/process-audit-helper",
    sha256: "a".repeat(64),
    mode: 0o100755,
    uid: 1000,
    gid: 1000,
    hasCapSysPtrace: true,
    mountNosuid: false,
    ...overrides,
  };
}

function emptyHelperStdout(): string {
  return [
    "state=empty",
    "self_ruid=1000",
    "target=/tmp/wt",
    "cap_sys_ptrace=yes",
    "match_count=0",
    "unknown_count=0",
  ].join("\n") + "\n";
}

function survivorsHelperStdout(pids: number[]): string {
  const lines = [
    "state=survivors",
    "self_ruid=1000",
    "target=/tmp/wt",
    "cap_sys_ptrace=yes",
    `match_count=${pids.length}`,
    "unknown_count=0",
    ...pids.map((p) => `match pid=${p} starttime=123 kind=fd fd=3`),
  ];
  return lines.join("\n") + "\n";
}

class MemoryStore implements FenceIdentityStore {
  readonly map = new Map<string, FenceIdentityV1>();
  storeOrder: FenceIdentityV1[] = [];
  async load(nonceDigest: string): Promise<FenceIdentityV1 | undefined> {
    return this.map.get(nonceDigest);
  }
  async create(identity: FenceIdentityV1): Promise<boolean> {
    if (this.map.has(identity.nonceDigest)) return false;
    this.storeOrder.push(structuredClone(identity));
    this.map.set(identity.nonceDigest, structuredClone(identity));
    return true;
  }
  async compareAndSet(expected: FenceIdentityV1, next: FenceIdentityV1): Promise<boolean> {
    if (JSON.stringify(this.map.get(expected.nonceDigest)) !== JSON.stringify(expected)) return false;
    this.storeOrder.push(structuredClone(next));
    this.map.set(next.nonceDigest, structuredClone(next));
    return true;
  }
}

class FakeClock implements FenceClock {
  now = 0;
  sleeps: number[] = [];
  nowMs(): number {
    return this.now;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.now += ms;
  }
  /** Advance without recording a sleep (for external time). */
  advance(ms: number): void {
    this.now += ms;
  }
}

function makeHarness(opts: {
  bootId?: string;
  helper?: HelperBinaryInspection;
  helperRun?: (wt: string, timeoutMs: number) => Promise<AuditHelperRunResult>;
  systemdAvailable?: boolean;
  cgroupAvailable?: boolean;
} = {}) {
  const bootId = opts.bootId ?? "boot-aaa";
  const helper = opts.helper ?? goodHelperInspection();
  const store = new MemoryStore();
  const clock = new FakeClock();
  const units = new Map<string, UnitState>();
  const stoppedUnits: string[] = [];
  let foreignStopAttempts = 0;

  const systemd: SystemdUserPort = {
    async isAvailable() {
      return opts.systemdAvailable ?? true;
    },
    async show(unitName: string) {
      const u = units.get(unitName);
      if (!u) {
        return {
          loadState: "not-found",
          activeState: "inactive",
          subState: "dead",
          id: unitName,
          invocationId: "",
          controlGroup: "",
        };
      }
      return { ...u.snap };
    },
    async stop(unitName: string) {
      const u = units.get(unitName);
      if (!u) {
        foreignStopAttempts++;
        return;
      }
      u.stopCalls++;
      stoppedUnits.push(unitName);
      u.snap = {
        ...u.snap,
        loadState: "not-found",
        activeState: "inactive",
        subState: "dead",
        controlGroup: "",
        invocationId: "",
      };
      u.events = { populated: 0, frozen: 0 };
      u.procs = [];
    },
  };

  const cgroup: CgroupFsPort = {
    async isAvailable() {
      return opts.cgroupAvailable ?? true;
    },
    async readEvents(controlGroup: string) {
      for (const u of units.values()) {
        if (u.snap.controlGroup === controlGroup || (u as { lastCg?: string }).lastCg === controlGroup) {
          if (u.snap.loadState === "not-found" && u.procs.length === 0 && u.events.populated === 0) {
            // Simulate kernel removing cgroup after last member when marked gone
            if ((u as { cgGone?: boolean }).cgGone) return "missing";
          }
          return { ...u.events };
        }
      }
      // Pinned path may outlive unit object if we mark gone
      for (const u of units.values()) {
        if ((u as { pinnedCg?: string }).pinnedCg === controlGroup) {
          if ((u as { cgGone?: boolean }).cgGone) return "missing";
          return { ...u.events };
        }
      }
      return "missing";
    },
    async readProcs(controlGroup: string) {
      for (const u of units.values()) {
        if (u.snap.controlGroup === controlGroup || (u as { pinnedCg?: string }).pinnedCg === controlGroup) {
          if ((u as { cgGone?: boolean }).cgGone) return "missing";
          return [...u.procs];
        }
      }
      return "missing";
    },
    async writeFreeze(controlGroup: string, freeze: boolean) {
      for (const u of units.values()) {
        if (u.snap.controlGroup === controlGroup || (u as { pinnedCg?: string }).pinnedCg === controlGroup) {
          u.freezeWrites.push(freeze);
          u.events = { ...u.events, frozen: freeze ? 1 : 0 };
          return;
        }
      }
      throw new Error(`writeFreeze: unknown cgroup ${controlGroup}`);
    },
    async writeKill(controlGroup: string) {
      for (const [name, u] of units.entries()) {
        if (u.snap.controlGroup === controlGroup || (u as { pinnedCg?: string }).pinnedCg === controlGroup) {
          u.killWrites++;
          u.procs = [];
          u.events = { populated: 0, frozen: u.events.frozen };
          (u as { cgGone?: boolean }).cgGone = true;
          u.snap = {
            ...u.snap,
            loadState: "not-found",
            activeState: "inactive",
            subState: "dead",
            controlGroup: "",
            invocationId: u.snap.invocationId, // may clear
          };
          // clear invocation after collect
          u.snap.invocationId = "";
          void name;
          return;
        }
      }
      throw new Error(`writeKill: unknown cgroup ${controlGroup}`);
    },
  };

  let helperRunImpl = opts.helperRun
    ?? (async (): Promise<AuditHelperRunResult> => ({
      timedOut: false,
      exitCode: 0,
      stdout: emptyHelperStdout(),
      stderr: "",
    }));

  const auditHelper: AuditHelperPort = {
    path: () => helper.path,
    async inspect() {
      return { ...helper };
    },
    async run(canonicalWorktree: string, timeoutMs: number) {
      return helperRunImpl(canonicalWorktree, timeoutMs);
    },
  };

  const boot: BootIdentityPort = {
    async getBootId() {
      return bootId;
    },
  };

  const deps: LinuxProcessFenceDeps = {
    systemd,
    cgroup,
    auditHelper,
    boot,
    store,
    clock,
    expectedHelperUid: helper.uid,
    expectedHelperPath: helper.path,
    expectedHelperSha256: helper.sha256,
    expectedRuntimeUid: helper.uid,
    waitBudgetMs: 200,
    pollIntervalMs: 10,
    helperTimeoutMs: 1000,
  };

  function putUnit(unitName: string, init: {
    invocationId: string;
    controlGroup: string;
    procs: number[];
    activeState?: string;
  }): UnitState {
    const state: UnitState & { pinnedCg?: string; cgGone?: boolean; lastCg?: string } = {
      snap: {
        loadState: "loaded",
        activeState: init.activeState ?? "active",
        subState: "running",
        id: unitName,
        invocationId: init.invocationId,
        controlGroup: init.controlGroup,
      },
      events: { populated: init.procs.length > 0 ? 1 : 0, frozen: 0 },
      procs: [...init.procs],
      freezeWrites: [],
      killWrites: 0,
      stopCalls: 0,
      pinnedCg: init.controlGroup,
      lastCg: init.controlGroup,
    };
    units.set(unitName, state);
    return state;
  }

  function setHelperRun(fn: typeof helperRunImpl): void {
    helperRunImpl = fn;
  }

  function setBootId(id: string): void {
    (boot as { getBootId: () => Promise<string> }).getBootId = async () => id;
  }

  return {
    deps,
    store,
    clock,
    units,
    putUnit,
    stoppedUnits,
    get foreignStopAttempts() {
      return foreignStopAttempts;
    },
    setHelperRun,
    setBootId,
    helper,
    async createFence(capability?: { supported: true; domain: string } | { supported: false; reason: string }) {
      if (capability) {
        return LinuxSystemdProcessFence.createWithCapability(deps, capability);
      }
      return LinuxSystemdProcessFence.create(deps);
    },
  };
}

async function launchAndConfirm(
  h: ReturnType<typeof makeHarness>,
  nonce: string,
  cmd = "delivery-writer",
  procs = [111, 222],
) {
  const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
  const prepared = await fence.prepareLaunch(nonce, cmd);
  const digest = nonceDigestOf(nonce);
  expect(prepared.nonceDigest).toBe(digest);
  expect(prepared.unitName).toBe(unitNameForDigest(digest));
  // Simulate host starting the scope
  h.putUnit(prepared.unitName, {
    invocationId: "inv-" + digest.slice(0, 8),
    controlGroup: `/user.slice/user-1000.slice/app.slice/${prepared.unitName}`,
    procs,
  });
  await fence.confirmLaunch(nonce);
  return { fence, prepared, digest };
}

// ── Pure helpers ───────────────────────────────────────────────────────────

describe("linuxProcessFence pure helpers", () => {
  it("digests nonces with SHA-256 and never echoes raw nonce in unit names", () => {
    const nonce = "secret-execution-nonce-xyz";
    const digest = nonceDigestOf(nonce);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(nonce);
    const unit = unitNameForDigest(digest);
    expect(unit).toBe(`tachyon-pf-${digest.slice(0, 32)}.scope`);
    expect(unit).not.toContain(nonce);
    expect(unit).not.toContain("secret");
  });

  it("posixShellQuote escapes embedded single quotes", () => {
    expect(posixShellQuote("a")).toBe("'a'");
    expect(posixShellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("wrapSystemdScopeCommand is shell-quoted systemd-run --user --scope --collect", () => {
    const cmd = wrapSystemdScopeCommand("tachyon-pf-abc.scope", "echo 'hi'");
    expect(cmd.startsWith("systemd-run --user --scope --collect --unit=")).toBe(true);
    expect(cmd).toContain("--unit='tachyon-pf-abc.scope'");
    expect(cmd).toContain("/bin/sh -c ");
    expect(cmd).toContain(posixShellQuote("echo 'hi'"));
    expect(cmd).not.toMatch(/--unit=[^']/); // unit always quoted
  });

  it("parseAuditHelperStdout is strict and non-optimistic", () => {
    expect(parseAuditHelperStdout(emptyHelperStdout(), "/tmp/wt", 1000)).toEqual({
      state: "empty",
      capSysPtrace: "yes",
      matchCount: 0,
      unknownCount: 0,
      matchPids: [],
    });
    expect(parseAuditHelperStdout(survivorsHelperStdout([9, 8]), "/tmp/wt", 1000)).toMatchObject({
      state: "survivors",
      matchCount: 2,
      matchPids: [9, 8],
    });
    expect(parseAuditHelperStdout("state=empty\n", "/tmp/wt", 1000)).toBeNull();
    expect(parseAuditHelperStdout("garbage\n", "/tmp/wt", 1000)).toBeNull();
    expect(parseAuditHelperStdout(
      emptyHelperStdout() + "state=empty\n", "/tmp/wt", 1000,
    )).toBeNull(); // duplicate key
    expect(parseAuditHelperStdout(
      "state=empty\ncap_sys_ptrace=yes\nmatch_count=0\nunknown_count=0\nextra=1\n", "/tmp/wt", 1000,
    )).toBeNull();
  });
});

// ── Unavailable byte-compatibility ─────────────────────────────────────────

describe("UnavailableProcessFence byte-compatible default", () => {
  it("keeps capability unsupported and proveEmpty unknown", async () => {
    const u = new UnavailableProcessFence();
    expect(u.capability()).toEqual({
      supported: false,
      reason: "independent canonical-worktree process absence cannot be proven on this host",
    });
    await expect(u.freeze()).rejects.toThrow(/PROCESS_FENCE_UNAVAILABLE/);
    await expect(u.terminate()).rejects.toThrow(/PROCESS_FENCE_UNAVAILABLE/);
    expect(await u.proveEmpty()).toEqual({
      state: "unknown",
      reason: "independent canonical-worktree process absence cannot be proven on this host",
    });
  });
});

// ── Factory / capability ───────────────────────────────────────────────────

describe("LinuxSystemdProcessFence capability probe", () => {
  it("caches supported domain when all ports pass", async () => {
    const h = makeHarness();
    const fence = await h.createFence();
    expect(fence.capability()).toEqual({
      supported: true,
      domain: LINUX_PROCESS_FENCE_DOMAIN,
    });
  });

  it("fails closed when helper lacks CAP_SYS_PTRACE", async () => {
    const h = makeHarness({ helper: goodHelperInspection({ hasCapSysPtrace: false }) });
    const fence = await h.createFence();
    expect(fence.capability().supported).toBe(false);
    await expect(fence.prepareLaunch("n1", "cmd")).rejects.toThrow(/PROCESS_FENCE_UNAVAILABLE/);
  });

  it("fails closed on nosuid helper mount", async () => {
    const h = makeHarness({ helper: goodHelperInspection({ mountNosuid: true }) });
    const fence = await h.createFence();
    expect(fence.capability().supported).toBe(false);
  });

  it("fails closed on helper owner mismatch", async () => {
    const h = makeHarness({ helper: goodHelperInspection({ uid: 0 }) });
    // Harness pins expectedHelperUid to helper.uid by default; force a real mismatch.
    h.deps.expectedHelperUid = 1000;
    const fence = await LinuxSystemdProcessFence.create(h.deps);
    expect(fence.capability().supported).toBe(false);
  });

  it("fails closed when systemd or cgroup unavailable", async () => {
    expect((await makeHarness({ systemdAvailable: false }).createFence()).capability().supported).toBe(false);
    expect((await makeHarness({ cgroupAvailable: false }).createFence()).capability().supported).toBe(false);
  });
});

// ── prepare / confirm / repair ─────────────────────────────────────────────

describe("prepareLaunch and confirmLaunch", () => {
  it("writes pending receipt before returning the command", async () => {
    const h = makeHarness();
    const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
    const nonce = "nonce-pending-order";
    const prepared = await fence.prepareLaunch(nonce, "my-cmd");
    const digest = nonceDigestOf(nonce);
    expect(h.store.storeOrder.length).toBe(1);
    expect(h.store.storeOrder[0]!.phase).toBe("pending");
    expect(h.store.storeOrder[0]!.nonceDigest).toBe(digest);
    expect(JSON.stringify(h.store.storeOrder[0])).not.toContain(nonce);
    expect(prepared.command).toContain("systemd-run --user --scope --collect");
    expect(prepared.command).toContain(prepared.unitName);
    expect(prepared.command).not.toContain(nonce);
    expect(prepared.command).toContain(posixShellQuote("my-cmd"));
  });

  it("quotes adversarial command payloads safely", async () => {
    const h = makeHarness();
    const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
    const evil = "'; touch /tmp/pwned; echo done";
    const prepared = await fence.prepareLaunch("n-quote", evil);
    expect(prepared.command).toContain(posixShellQuote(evil));
    expect(prepared.command).toContain("/bin/sh -c ");
    // raw semicolon must only appear inside the single-quoted payload
    const withoutQuoted = prepared.command.replace(posixShellQuote(evil), "");
    expect(withoutQuoted).not.toContain("touch /tmp/pwned");
  });

  it("confirmLaunch pins InvocationID and ControlGroup after membership checks", async () => {
    const h = makeHarness();
    const { fence, prepared, digest } = await launchAndConfirm(h, "nonce-confirm", "cmd", [10, 20]);
    const id = await h.store.load(digest);
    expect(id?.phase).toBe("confirmed");
    expect(id?.invocationId).toBe("inv-" + digest.slice(0, 8));
    expect(id?.controlGroup).toBe(`/user.slice/user-1000.slice/app.slice/${prepared.unitName}`);
    void fence;
  });

  it("repairs missing pending receipt only from exact deterministic live unit on same boot", async () => {
    const h = makeHarness();
    const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
    const nonce = "nonce-repair";
    const digest = nonceDigestOf(nonce);
    const unit = unitNameForDigest(digest);
    h.putUnit(unit, {
      invocationId: "inv-repair",
      controlGroup: `/cg/${unit}`,
      procs: [1],
    });
    // No store receipt — repair path
    await fence.confirmLaunch(nonce);
    const id = await h.store.load(digest);
    expect(id?.phase).toBe("confirmed");
    expect(id?.unitName).toBe(unit);
    expect(id?.invocationId).toBe("inv-repair");
  });

  it("refuses confirm when unit is absent and no receipt exists", async () => {
    const h = makeHarness();
    const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
    await expect(fence.confirmLaunch("nonce-absent")).rejects.toThrow(/no fence identity|repair failed/);
  });

  it("detects boot drift between prepare and confirm", async () => {
    const h = makeHarness();
    const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
    const nonce = "nonce-boot-drift";
    const prepared = await fence.prepareLaunch(nonce, "cmd");
    h.putUnit(prepared.unitName, {
      invocationId: "inv-x",
      controlGroup: `/cg/${prepared.unitName}`,
      procs: [1],
    });
    h.setBootId("boot-other");
    await expect(fence.confirmLaunch(nonce)).rejects.toThrow(/boot id/);
  });

  it("detects unit id collision / wrong unit identity", async () => {
    const h = makeHarness();
    const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
    const nonce = "nonce-collision";
    const prepared = await fence.prepareLaunch(nonce, "cmd");
    const u = h.putUnit(prepared.unitName, {
      invocationId: "inv-c",
      controlGroup: `/cg/${prepared.unitName}`,
      procs: [1],
    });
    u.snap.id = "someone-else.scope";
    await expect(fence.confirmLaunch(nonce)).rejects.toThrow(/unit id/);
  });
});

// ── freeze / terminate identity gates ──────────────────────────────────────

describe("freeze and terminate", () => {
  it("freeze writes cgroup.freeze=1 and waits for frozen=1", async () => {
    const h = makeHarness();
    const { fence, prepared } = await launchAndConfirm(h, "nonce-freeze");
    const unit = h.units.get(prepared.unitName)!;
    // Delay frozen observation by one poll
    let reads = 0;
    const orig = h.deps.cgroup.readEvents.bind(h.deps.cgroup);
    h.deps.cgroup.readEvents = async (cg) => {
      reads++;
      if (reads < 2) return { populated: 1, frozen: 0 };
      return orig(cg);
    };
    await fence.freeze("nonce-freeze");
    expect(unit.freezeWrites).toContain(true);
  });

  it("freeze refuses on InvocationID drift", async () => {
    const h = makeHarness();
    const { fence, prepared } = await launchAndConfirm(h, "nonce-freeze-drift");
    const unit = h.units.get(prepared.unitName)!;
    unit.snap.invocationId = "totally-different";
    await expect(fence.freeze("nonce-freeze-drift")).rejects.toThrow(/InvocationID/);
  });

  it("freeze refuses on ControlGroup drift", async () => {
    const h = makeHarness();
    const { fence, prepared } = await launchAndConfirm(h, "nonce-cg-drift");
    const unit = h.units.get(prepared.unitName)!;
    unit.snap.controlGroup = "/other/cgroup";
    await expect(fence.freeze("nonce-cg-drift")).rejects.toThrow(/ControlGroup/);
  });

  it("terminate kills only the pinned unit and waits populated=0", async () => {
    const h = makeHarness();
    const { fence, prepared } = await launchAndConfirm(h, "nonce-kill", "cmd", [50, 60]);
    // Foreign unit must never be touched
    h.putUnit("foreign.scope", {
      invocationId: "inv-foreign",
      controlGroup: "/cg/foreign.scope",
      procs: [999],
    });
    await fence.terminate("nonce-kill");
    const unit = h.units.get(prepared.unitName)!;
    expect(unit.killWrites).toBe(1);
    const foreign = h.units.get("foreign.scope")!;
    expect(foreign.killWrites).toBe(0);
    expect(foreign.procs).toEqual([999]);
    expect(h.stoppedUnits.every((n) => n === prepared.unitName)).toBe(true);
  });

  it("terminate times out when populated never clears", async () => {
    const h = makeHarness();
    const { fence, prepared } = await launchAndConfirm(h, "nonce-kill-timeout", "cmd", [1]);
    h.deps.cgroup.writeKill = async () => {
      /* no-op: leave populated */
      const u = h.units.get(prepared.unitName)!;
      u.killWrites++;
    };
    await expect(fence.terminate("nonce-kill-timeout")).rejects.toThrow(/PROCESS_FENCE_TIMEOUT/);
  });

  it("never stops a unit that is not the pinned identity", async () => {
    const h = makeHarness();
    const { fence } = await launchAndConfirm(h, "nonce-no-foreign");
    const stopCalls: string[] = [];
    const origStop = h.deps.systemd.stop.bind(h.deps.systemd);
    h.deps.systemd.stop = async (name) => {
      stopCalls.push(name);
      return origStop(name);
    };
    await fence.terminate("nonce-no-foreign");
    expect(stopCalls.every((n) => n === unitNameForDigest(nonceDigestOf("nonce-no-foreign")))).toBe(true);
  });
});

// ── proveEmpty helper matrix ───────────────────────────────────────────────

describe("proveEmpty", () => {
  it("returns proven_empty only for exit0/empty/cap=yes/match0/unknown0 and empty cgroup", async () => {
    const h = makeHarness();
    const { fence } = await launchAndConfirm(h, "nonce-empty", "cmd", [1]);
    await fence.terminate("nonce-empty");
    const proof = await fence.proveEmpty("nonce-empty", "/tmp/wt");
    expect(proof).toEqual({ state: "proven_empty" });
  });

  it("returns survivors with bounded pids from helper exit 1", async () => {
    const h = makeHarness();
    h.setHelperRun(async () => ({
      timedOut: false,
      exitCode: 1,
      stdout: survivorsHelperStdout([4242, 7]),
      stderr: "",
    }));
    const { fence } = await launchAndConfirm(h, "nonce-surv", "cmd", [1]);
    await fence.terminate("nonce-surv");
    const proof = await fence.proveEmpty("nonce-surv", "/tmp/wt");
    expect(proof).toEqual({ state: "survivors", pids: [7, 4242] });
  });

  it("returns unknown on helper timeout", async () => {
    const h = makeHarness();
    h.setHelperRun(async () => ({ timedOut: true }));
    const { fence } = await launchAndConfirm(h, "nonce-hto", "cmd", [1]);
    await fence.terminate("nonce-hto");
    const proof = await fence.proveEmpty("nonce-hto", "/tmp/wt");
    expect(proof.state).toBe("unknown");
    if (proof.state === "unknown") expect(proof.reason).toMatch(/timed out/i);
  });

  it("returns unknown on malformed helper output", async () => {
    const h = makeHarness();
    h.setHelperRun(async () => ({
      timedOut: false,
      exitCode: 0,
      stdout: "state=empty\n",
      stderr: "",
    }));
    const { fence } = await launchAndConfirm(h, "nonce-mal", "cmd", [1]);
    await fence.terminate("nonce-mal");
    const proof = await fence.proveEmpty("nonce-mal", "/tmp/wt");
    expect(proof.state).toBe("unknown");
  });

  it("returns unknown on exit/state inconsistency", async () => {
    const h = makeHarness();
    h.setHelperRun(async () => ({
      timedOut: false,
      exitCode: 0,
      stdout: survivorsHelperStdout([1]),
      stderr: "",
    }));
    const { fence } = await launchAndConfirm(h, "nonce-incons", "cmd", [1]);
    await fence.terminate("nonce-incons");
    const proof = await fence.proveEmpty("nonce-incons", "/tmp/wt");
    expect(proof.state).toBe("unknown");
  });

  it("returns unknown when cap_sys_ptrace=no even with exit 0 shape", async () => {
    const h = makeHarness();
    h.setHelperRun(async () => ({
      timedOut: false,
      exitCode: 0,
      stdout: emptyHelperStdout().replace("cap_sys_ptrace=yes", "cap_sys_ptrace=no"),
      stderr: "",
    }));
    const { fence } = await launchAndConfirm(h, "nonce-nocap", "cmd", [1]);
    await fence.terminate("nonce-nocap");
    const proof = await fence.proveEmpty("nonce-nocap", "/tmp/wt");
    expect(proof.state).toBe("unknown");
  });

  it("returns unknown on helper hash drift vs identity", async () => {
    const h = makeHarness();
    const { fence } = await launchAndConfirm(h, "nonce-hash", "cmd", [1]);
    await fence.terminate("nonce-hash");
    // Mutate inspection sha after confirm
    const origInspect = h.deps.auditHelper.inspect.bind(h.deps.auditHelper);
    h.deps.auditHelper.inspect = async () => {
      const i = await origInspect();
      return { ...i, sha256: "b".repeat(64) };
    };
    const proof = await fence.proveEmpty("nonce-hash", "/tmp/wt");
    expect(proof.state).toBe("unknown");
    if (proof.state === "unknown") expect(proof.reason).toMatch(/sha256|path/i);
  });

  it("returns survivors from cgroup when still populated (detached writer)", async () => {
    const h = makeHarness();
    const { fence } = await launchAndConfirm(h, "nonce-detach", "cmd", [111, 222]);
    // Pane-root dies; detached writer remains
    const unit = h.units.get(unitNameForDigest(nonceDigestOf("nonce-detach")))!;
    unit.procs = [222];
    unit.events = { populated: 1, frozen: 0 };
    const proof = await fence.proveEmpty("nonce-detach", "/tmp/wt");
    expect(proof).toEqual({ state: "survivors", pids: [222] });
  });

  it("returns unknown on boot drift at proveEmpty", async () => {
    const h = makeHarness();
    const { fence } = await launchAndConfirm(h, "nonce-pboot", "cmd", [1]);
    await fence.terminate("nonce-pboot");
    h.setBootId("rebooted");
    const proof = await fence.proveEmpty("nonce-pboot", "/tmp/wt");
    expect(proof.state).toBe("unknown");
  });

  it("returns unknown when fence not confirmed", async () => {
    const h = makeHarness();
    const fence = await h.createFence({ supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN });
    await fence.prepareLaunch("nonce-pend", "cmd");
    const proof = await fence.proveEmpty("nonce-pend", "/tmp/wt");
    expect(proof.state).toBe("unknown");
  });

  it("unsupported capability proveEmpty is unknown without OS calls", async () => {
    const h = makeHarness();
    const fence = await h.createFence({
      supported: false,
      reason: "independent canonical-worktree process absence cannot be proven on this host",
    });
    const proof = await fence.proveEmpty("x", "/tmp/wt");
    expect(proof).toEqual({
      state: "unknown",
      reason: "independent canonical-worktree process absence cannot be proven on this host",
    });
  });
});

// ── Canonical adversarial story ────────────────────────────────────────────

describe("detached Delivery writer vs handoff fence", () => {
  it("a detached Delivery writer survives pane death but cannot cross handoff after scope kill and exact audit", async () => {
    const h = makeHarness();
    const nonce = "delivery-exec-nonce-canonical";
    const { fence, prepared } = await launchAndConfirm(h, nonce, "delivery-writer --worktree /tmp/wt", [1001, 1002]);

    // Pane death: root 1001 exits; double-fork writer 1002 remains in cgroup
    const unit = h.units.get(prepared.unitName)!;
    unit.procs = [1002];
    unit.events = { populated: 1, frozen: 0 };
    unit.snap.controlGroup = unit.snap.controlGroup; // identity stable

    // Handoff must not proceed while writer survives
    const beforeKill = await fence.proveEmpty(nonce, "/tmp/wt");
    expect(beforeKill).toEqual({ state: "survivors", pids: [1002] });

    // Freeze + scope kill + exact audit
    await fence.freeze(nonce);
    expect(unit.freezeWrites).toContain(true);
    // thaw not required for handoff path; terminate kills
    // re-sync identity after freeze (unit still live)
    unit.events = { populated: 1, frozen: 1 };
    // For terminate, assertExactLiveIdentity needs matching invocation/cg — still set
    await fence.terminate(nonce);

    h.setHelperRun(async () => ({
      timedOut: false,
      exitCode: 0,
      stdout: emptyHelperStdout(),
      stderr: "",
    }));

    const after = await fence.proveEmpty(nonce, "/tmp/wt");
    expect(after).toEqual({ state: "proven_empty" });

    // Identity receipts never held the raw nonce
    for (const rec of h.store.storeOrder) {
      expect(JSON.stringify(rec)).not.toContain(nonce);
    }
    expect(prepared.command).not.toContain(nonce);
  });
});
