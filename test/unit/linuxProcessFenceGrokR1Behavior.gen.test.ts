import { describe, expect, it } from "vitest";
import {
  LinuxSystemdProcessFence,
  LINUX_PROCESS_FENCE_DOMAIN,
  nonceDigestOf,
  unitNameForDigest,
  type AuditHelperPort,
  type BootIdentityPort,
  type CgroupEvents,
  type CgroupFsPort,
  type FenceClock,
  type FenceIdentityStore,
  type FenceIdentityV1,
  type HelperBinaryInspection,
  type SystemdUnitSnapshot,
  type SystemdUserPort,
} from "../../src/agents/linuxProcessFence.js";

/**
 * Canonical gate for T14.6A:
 * "a detached Delivery writer survives pane death but cannot cross handoff after scope kill and exact audit"
 *
 * Deterministic injected-port simulation of the ratified cgroup spike + exact audit contract.
 */
describe("container-generated delegation behavior", () => {
  it("a detached Delivery writer survives pane death but cannot cross handoff after scope kill and exact audit", async () => {
    const helper: HelperBinaryInspection = {
      path: "/opt/tachyon/process-audit-helper",
      sha256: "c".repeat(64),
      mode: 0o100755,
      uid: 1000,
      gid: 1000,
      hasCapSysPtrace: true,
      mountNosuid: false,
    };

    const storeMap = new Map<string, FenceIdentityV1>();
    const store: FenceIdentityStore = {
      async load(d) {
        return storeMap.get(d);
      },
      async create(identity) {
        if (storeMap.has(identity.nonceDigest)) return false;
        storeMap.set(identity.nonceDigest, structuredClone(identity));
        return true;
      },
      async compareAndSet(expected, next) {
        if (JSON.stringify(storeMap.get(expected.nonceDigest)) !== JSON.stringify(expected)) return false;
        storeMap.set(next.nonceDigest, structuredClone(next));
        return true;
      },
    };

    let now = 0;
    const clock: FenceClock = {
      nowMs: () => now,
      async sleep(ms) {
        now += ms;
      },
    };

    type U = {
      snap: SystemdUnitSnapshot;
      events: CgroupEvents;
      procs: number[];
      pinnedCg: string;
      cgGone: boolean;
      killWrites: number;
    };
    const units = new Map<string, U>();

    const systemd: SystemdUserPort = {
      async isAvailable() {
        return true;
      },
      async show(unitName) {
        const u = units.get(unitName);
        if (!u || u.cgGone) {
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
      async stop(unitName) {
        const u = units.get(unitName);
        if (!u) return;
        u.cgGone = true;
        u.procs = [];
        u.events = { populated: 0, frozen: 0 };
        u.snap = {
          ...u.snap,
          loadState: "not-found",
          activeState: "inactive",
          subState: "dead",
          invocationId: "",
          controlGroup: "",
        };
      },
    };

    const cgroup: CgroupFsPort = {
      async isAvailable() {
        return true;
      },
      async readEvents(cg) {
        for (const u of units.values()) {
          if (u.pinnedCg === cg) {
            if (u.cgGone) return "missing";
            return { ...u.events };
          }
        }
        return "missing";
      },
      async readProcs(cg) {
        for (const u of units.values()) {
          if (u.pinnedCg === cg) {
            if (u.cgGone) return "missing";
            return [...u.procs];
          }
        }
        return "missing";
      },
      async writeFreeze(cg, freeze) {
        for (const u of units.values()) {
          if (u.pinnedCg === cg && !u.cgGone) {
            u.events = { ...u.events, frozen: freeze ? 1 : 0 };
            return;
          }
        }
        throw new Error("freeze: unknown cgroup");
      },
      async writeKill(cg) {
        for (const u of units.values()) {
          if (u.pinnedCg === cg) {
            u.killWrites++;
            u.procs = [];
            u.events = { populated: 0, frozen: 0 };
            u.cgGone = true;
            u.snap = {
              ...u.snap,
              loadState: "not-found",
              activeState: "inactive",
              subState: "dead",
              invocationId: "",
              controlGroup: "",
            };
            return;
          }
        }
        throw new Error("kill: unknown cgroup");
      },
    };

    const auditHelper: AuditHelperPort = {
      path: () => helper.path,
      async inspect() {
        return { ...helper };
      },
      async run() {
        return {
          timedOut: false,
          exitCode: 0,
          stdout: [
            "state=empty",
            "self_ruid=1000",
            "target=/tmp/canonical-wt",
            "cap_sys_ptrace=yes",
            "match_count=0",
            "unknown_count=0",
          ].join("\n") + "\n",
          stderr: "",
        };
      },
    };

    const boot: BootIdentityPort = {
      async getBootId() {
        return "boot-canonical-1";
      },
    };

    const fence = LinuxSystemdProcessFence.createWithCapability(
      {
        systemd,
        cgroup,
        auditHelper,
        boot,
        store,
        clock,
        expectedHelperUid: 1000,
        expectedHelperPath: helper.path,
        expectedHelperSha256: helper.sha256,
        expectedRuntimeUid: 1000,
        waitBudgetMs: 500,
        pollIntervalMs: 5,
      },
      { supported: true, domain: LINUX_PROCESS_FENCE_DOMAIN },
    );

    const executionNonce = "canonical-delivery-execution-nonce";
    const prepared = await fence.prepareLaunch(executionNonce, "delivery-writer");
    expect(prepared.command).toContain("systemd-run --user --scope --collect");
    expect(prepared.command).not.toContain(executionNonce);
    expect(prepared.unitName).toBe(unitNameForDigest(nonceDigestOf(executionNonce)));

    // Scope is live with pane-root + detached writer
    const cg = `/user.slice/app.slice/${prepared.unitName}`;
    units.set(prepared.unitName, {
      snap: {
        loadState: "loaded",
        activeState: "active",
        subState: "running",
        id: prepared.unitName,
        invocationId: "inv-canonical-1",
        controlGroup: cg,
      },
      events: { populated: 1, frozen: 0 },
      procs: [5001, 5002],
      pinnedCg: cg,
      cgGone: false,
      killWrites: 0,
    });

    await fence.confirmLaunch(executionNonce);

    // Pane death: root gone, detached writer survives in the same unit cgroup
    const live = units.get(prepared.unitName)!;
    live.procs = [5002];
    live.events = { populated: 1, frozen: 0 };

    const blocked = await fence.proveEmpty(executionNonce, "/tmp/canonical-wt");
    expect(blocked).toEqual({ state: "survivors", pids: [5002] });

    // Handoff path: freeze → terminate (scope kill) → exact audit
    await fence.freeze(executionNonce);
    await fence.terminate(executionNonce);
    expect(live.killWrites).toBe(1);

    const cleared = await fence.proveEmpty(executionNonce, "/tmp/canonical-wt");
    expect(cleared).toEqual({ state: "proven_empty" });

    // Receipts never store the raw nonce
    for (const rec of storeMap.values()) {
      expect(JSON.stringify(rec)).not.toContain(executionNonce);
      expect(rec.nonceDigest).toBe(nonceDigestOf(executionNonce));
    }
  });
});
