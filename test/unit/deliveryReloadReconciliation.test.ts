import { afterEach, describe, expect, it } from "vitest";
import type { Delivery } from "../../src/delivery/types.js";
import {
  reconcileDeliveryReload,
  readLinuxProcessIdentity,
  type LinkedGitProjection,
  type ObservedProcess,
} from "../../src/delivery/reloadReconciliation.js";
import type { SessionRecord } from "../../src/resume/SessionLedger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function baseDelivery(over: Partial<Delivery> & { id: string }): Delivery {
  const now = "2026-07-12T00:00:00.000Z";
  const segmentId = (over.lease?.holder?.segmentId as string | undefined) ?? "seg-1";
  const executionAgent = over.lease?.holder?.executionAgent ?? "holder";
  // Align holder/tail principal (lease held-boundary equality); never invent principal inference.
  const defaultPrincipal = executionAgent;
  return {
    schemaVersion: 1,
    id: over.id,
    version: 1,
    workspaceId: "ws",
    createdBy: { kind: "system", name: "tachyon" },
    contract: {
      baseSha: "abc",
      behaviorTest: "gate",
      owns: ["src"],
      taskRef: "tachyon/d",
    },
    lease: over.lease ?? {
      state: "held",
      holder: {
        segmentId,
        executionAgent,
        principal: defaultPrincipal,
        process: { pid: 4242, processStart: "1000", bootId: "boot-a" },
        executionNonce: "nonce-1",
      },
      expectedHeadSha: "abc",
      changedAt: now,
    },
    segments: over.segments ?? [
      {
        id: segmentId,
        index: 0,
        role: "implementer",
        executionAgent,
        principal: defaultPrincipal,
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "abc",
        grantedAt: now,
      },
    ],
    events: [],
    gitDeliveryId: over.gitDeliveryId ?? "gd-1",
    createdAt: now,
    updatedAt: now,
    ...("version" in over ? { version: over.version! } : {}),
  };
}

const tempDirs: string[] = [];
function tempWorktree(label = "t14-r3-wt-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function session(over: Partial<SessionRecord> & { cwd: string }): SessionRecord {
  return {
    def: { cmd: "claude", kind: "agent" },
    resume: { runtime: "claude", sessionId: "s" },
    declared: false,
    updatedAt: "t",
    ...over,
  };
}

function proj(deliveryId: string, worktreePath: string, gitDeliveryId = "gd-1"): LinkedGitProjection {
  return { gitDeliveryId, deliveryId, worktreePath };
}

const exactObs = (pid = 4242, processStart = "1000", bootId = "boot-a"): ObservedProcess => ({
  state: "exact",
  pid,
  processStart,
  bootId,
});

const goodSession = (deliveryId: string, wt: string, nonce = "nonce-1"): SessionRecord =>
  session({
    cwd: wt,
    worktree: { path: wt, branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
    delivery: { deliveryId, segmentId: "seg-1", executionNonce: nonce },
  });

describe("reload reconciliation (SDD 368 T14)", () => {
  it("reconstructs exact held when holder/tail/HEAD/binding/cwd+worktree/process all match", () => {
    const wt = tempWorktree();
    const delivery = baseDelivery({ id: "d-held" });
    const sessions = new Map([["holder", goodSession("d-held", wt)]]);
    const snap = reconcileDeliveryReload({
      deliveries: [delivery],
      linkedProjections: [proj("d-held", wt)],
      sessions,
      processByAgent: new Map([["holder", exactObs()]]),
    });
    expect(snap.byId.get("d-held")).toMatchObject({
      class: "held",
      holderAgent: "holder",
    });
    expect(snap.unavailableAgents.has("holder")).toBe(true);
  });

  it("SDD 368 T14/R3 exact-held requires an existing realpathed worktree (no path.resolve fallback)", () => {
    const wt = tempWorktree();
    const delivery = baseDelivery({ id: "d-missing-wt" });
    // Exact binding/process data, but the linked projection path is deleted / nonexistent.
    fs.rmSync(wt, { recursive: true, force: true });
    const gone = wt;
    const snap = reconcileDeliveryReload({
      deliveries: [delivery],
      linkedProjections: [proj("d-missing-wt", gone)],
      sessions: new Map([["holder", goodSession("d-missing-wt", gone)]]),
      processByAgent: new Map([["holder", exactObs()]]),
    });
    expect(snap.byId.get("d-missing-wt")?.class).toBe("unavailable");
    expect(snap.byId.get("d-missing-wt")?.reason).toMatch(/does not exist|not realpathable/i);
    // Fictional never-created paths also fail closed even when all three strings match.
    const phantom = path.join(os.tmpdir(), `t14-r3-phantom-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const phantomSnap = reconcileDeliveryReload({
      deliveries: [baseDelivery({ id: "d-phantom" })],
      linkedProjections: [proj("d-phantom", phantom)],
      sessions: new Map([["holder", goodSession("d-phantom", phantom)]]),
      processByAgent: new Map([["holder", exactObs()]]),
    });
    expect(phantomSnap.byId.get("d-phantom")?.class).toBe("unavailable");
  });

  it("SDD 368 T14/R3 held boundary requires grantedHeadSha and principal equality without inference", () => {
    const wt = tempWorktree();
    const headDrift = baseDelivery({
      id: "d-head-drift",
      lease: {
        state: "held",
        holder: {
          segmentId: "seg-1",
          executionAgent: "holder",
          principal: "holder",
          process: { pid: 4242, processStart: "1000", bootId: "boot-a" },
          executionNonce: "nonce-1",
        },
        expectedHeadSha: "expected-head",
        changedAt: "t",
      },
      segments: [{
        id: "seg-1",
        index: 0,
        role: "implementer",
        executionAgent: "holder",
        principal: "holder",
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "OTHER-head",
        grantedAt: "t",
      }],
    });
    const principalDrift = baseDelivery({
      id: "d-prin-drift",
      lease: {
        state: "held",
        holder: {
          segmentId: "seg-1",
          executionAgent: "holder",
          principal: "alice",
          process: { pid: 4242, processStart: "1000", bootId: "boot-a" },
          executionNonce: "nonce-1",
        },
        expectedHeadSha: "abc",
        changedAt: "t",
      },
      segments: [{
        id: "seg-1",
        index: 0,
        role: "implementer",
        executionAgent: "holder",
        principal: "bob",
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "abc",
        grantedAt: "t",
      }],
    });
    for (const d of [headDrift, principalDrift]) {
      const snap = reconcileDeliveryReload({
        deliveries: [d],
        linkedProjections: [proj(d.id, wt)],
        sessions: new Map([["holder", goodSession(d.id, wt)]]),
        processByAgent: new Map([["holder", exactObs()]]),
      });
      expect(snap.byId.get(d.id)?.class, d.id).toBe("unavailable");
      expect(snap.unavailableAgents.has("holder"), d.id).toBe(true);
    }
    expect(reconcileDeliveryReload({
      deliveries: [headDrift],
      linkedProjections: [proj("d-head-drift", wt)],
      sessions: new Map([["holder", goodSession("d-head-drift", wt)]]),
      processByAgent: new Map([["holder", exactObs()]]),
    }).byId.get("d-head-drift")?.reason).toMatch(/grantedHeadSha/i);
    expect(reconcileDeliveryReload({
      deliveries: [principalDrift],
      linkedProjections: [proj("d-prin-drift", wt)],
      sessions: new Map([["holder", goodSession("d-prin-drift", wt)]]),
      processByAgent: new Map([["holder", exactObs()]]),
    }).byId.get("d-prin-drift")?.reason).toMatch(/principal/i);
  });

  it("preserves quarantined regardless of missing runtime metadata", () => {
    const delivery = baseDelivery({
      id: "d-q",
      lease: { state: "quarantined", reason: "dirty", changedAt: "t" },
      segments: [],
      gitDeliveryId: undefined,
    });
    const snap = reconcileDeliveryReload({
      deliveries: [delivery],
      linkedProjections: [],
      sessions: new Map(),
      processByAgent: new Map(),
    });
    expect(snap.byId.get("d-q")).toMatchObject({ class: "quarantined" });
  });

  it("marks pending/draining/verifying unavailable after reload", () => {
    for (const state of ["pending", "draining", "verifying"] as const) {
      const delivery = baseDelivery({
        id: `d-${state}`,
        lease: {
          state,
          holder: { segmentId: "seg-1", executionAgent: "h", reservationNonce: "r" },
          changedAt: "t",
        },
      });
      const snap = reconcileDeliveryReload({
        deliveries: [delivery],
        linkedProjections: [proj(`d-${state}`, "/wt")],
        sessions: new Map(),
        processByAgent: new Map(),
      });
      expect(snap.byId.get(`d-${state}`)?.class).toBe("unavailable");
      expect(snap.unavailableAgents.has("h")).toBe(true);
    }
  });

  it("free/abandoned without stale binding are terminal (non-occupied); stale binding makes unavailable", () => {
    const free = baseDelivery({
      id: "d-free",
      lease: { state: "free", changedAt: "t" },
      segments: [],
      gitDeliveryId: undefined,
    });
    const freeSnap = reconcileDeliveryReload({
      deliveries: [free],
      linkedProjections: [],
      sessions: new Map(),
      processByAgent: new Map(),
    });
    expect(freeSnap.byId.get("d-free")).toMatchObject({ class: "terminal" });
    expect(freeSnap.unavailableAgents.size).toBe(0);

    const abandoned = baseDelivery({
      id: "d-ab",
      lease: { state: "abandoned", changedAt: "t" },
      segments: [{
        id: "seg-1", index: 0, role: "implementer", executionAgent: "was-holder",
        grantedBy: { kind: "system" }, ownsSubset: [], grantedHeadSha: "abc", grantedAt: "t",
        releasedAt: "t2", releasedHeadSha: "abc", outcome: "completed",
      }],
      gitDeliveryId: undefined,
    });
    const stale = new Map([
      ["ghost", session({
        cwd: "/wt",
        worktree: { path: "/wt", branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
        delivery: { deliveryId: "d-ab", segmentId: "seg-1", executionNonce: "old" },
      })],
    ]);
    const staleSnap = reconcileDeliveryReload({
      deliveries: [abandoned],
      linkedProjections: [],
      sessions: stale,
      processByAgent: new Map(),
    });
    expect(staleSnap.byId.get("d-ab")?.class).toBe("unavailable");
    expect(staleSnap.unavailableAgents.has("ghost")).toBe(true);
  });

  it("fails closed on each held ambiguity (missing process, pid reuse, no binding, bad paths, no nonce)", () => {
    const held = baseDelivery({ id: "d-h" });
    const good = goodSession("d-h", "/wt/d-h");

    const cases: Array<{
      name: string;
      sessions: Map<string, SessionRecord>;
      process: Map<string, ObservedProcess>;
      projections?: LinkedGitProjection[];
    }> = [
      {
        name: "process gone",
        sessions: new Map([["holder", good]]),
        process: new Map([["holder", { state: "gone" }]]),
      },
      {
        name: "pid reuse (start mismatch)",
        sessions: new Map([["holder", good]]),
        process: new Map([["holder", exactObs(4242, "9999", "boot-a")]]),
      },
      {
        name: "missing session binding",
        sessions: new Map([["holder", session({ cwd: "/wt/d-h" })]]),
        process: new Map([["holder", exactObs()]]),
      },
      {
        name: "worktree mismatch",
        sessions: new Map([["holder", good]]),
        process: new Map([["holder", exactObs()]]),
        projections: [proj("d-h", "/wt/OTHER")],
      },
      {
        name: "cwd mismatch while worktree path matches",
        sessions: new Map([["holder", session({
          cwd: "/wt/OTHER-cwd",
          worktree: { path: "/wt/d-h", branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
          delivery: { deliveryId: "d-h", segmentId: "seg-1", executionNonce: "nonce-1" },
        })]]),
        process: new Map([["holder", exactObs()]]),
      },
      {
        name: "worktree path mismatch while cwd matches",
        sessions: new Map([["holder", session({
          cwd: "/wt/d-h",
          worktree: { path: "/wt/OTHER-wt", branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
          delivery: { deliveryId: "d-h", segmentId: "seg-1", executionNonce: "nonce-1" },
        })]]),
        process: new Map([["holder", exactObs()]]),
      },
      {
        name: "cwd only (no worktree record) is under-checked and fails closed",
        sessions: new Map([["holder", session({
          cwd: "/wt/d-h",
          delivery: { deliveryId: "d-h", segmentId: "seg-1", executionNonce: "nonce-1" },
        })]]),
        process: new Map([["holder", exactObs()]]),
      },
      {
        name: "missing executionNonce on binding (pre-sequential)",
        sessions: new Map([["holder", session({
          cwd: "/wt/d-h",
          worktree: { path: "/wt/d-h", branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
          delivery: { deliveryId: "d-h", segmentId: "seg-1" },
        })]]),
        process: new Map([["holder", exactObs()]]),
      },
      {
        name: "missing linked projection",
        sessions: new Map([["holder", good]]),
        process: new Map([["holder", exactObs()]]),
        projections: [],
      },
      {
        name: "unknown process observation",
        sessions: new Map([["holder", good]]),
        process: new Map([["holder", { state: "unknown", reason: "no /proc" }]]),
      },
    ];

    for (const c of cases) {
      const snap = reconcileDeliveryReload({
        deliveries: [held],
        linkedProjections: c.projections ?? [proj("d-h", "/wt/d-h")],
        sessions: c.sessions,
        processByAgent: c.process,
      });
      expect(snap.byId.get("d-h")?.class, c.name).toBe("unavailable");
      // Marker-less holder still lands in the deny set (crash-window safety).
      expect(snap.unavailableAgents.has("holder"), c.name).toBe(true);
    }
  });

  it("fails closed on duplicate linked projections (no last-wins)", () => {
    const held = baseDelivery({ id: "d-dup" });
    const sessions = new Map([["holder", goodSession("d-dup", "/wt/d-dup")]]);
    const snap = reconcileDeliveryReload({
      deliveries: [held],
      linkedProjections: [
        proj("d-dup", "/wt/d-dup", "gd-a"),
        proj("d-dup", "/wt/d-dup-other", "gd-b"),
      ],
      sessions,
      processByAgent: new Map([["holder", exactObs()]]),
    });
    expect(snap.byId.get("d-dup")?.class).toBe("unavailable");
    expect(snap.byId.get("d-dup")?.reason).toMatch(/duplicate|conflict/i);
  });

  it("fails closed on duplicate differently-named session bindings", () => {
    const wt = tempWorktree();
    const held = baseDelivery({ id: "d-bind" });
    const sessions = new Map([
      ["holder", goodSession("d-bind", wt)],
      ["intruder", session({
        cwd: wt,
        worktree: { path: wt, branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
        delivery: { deliveryId: "d-bind", segmentId: "seg-OTHER", executionNonce: "other" },
      })],
    ]);
    const snap = reconcileDeliveryReload({
      deliveries: [held],
      linkedProjections: [proj("d-bind", wt)],
      sessions,
      processByAgent: new Map([["holder", exactObs()]]),
    });
    expect(snap.byId.get("d-bind")?.class).toBe("unavailable");
    expect(snap.byId.get("d-bind")?.reason).toMatch(/duplicate session bindings/);
    expect(snap.unavailableAgents.has("holder")).toBe(true);
    expect(snap.unavailableAgents.has("intruder")).toBe(true);
  });

  it("orphan binding to a missing Delivery is unavailable (deny set) without inventing a delivery row", () => {
    const sessions = new Map([
      ["orphan", session({
        cwd: "/wt",
        worktree: { path: "/wt", branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
        delivery: { deliveryId: "d-missing", segmentId: "seg-x", executionNonce: "n" },
      })],
    ]);
    const snap = reconcileDeliveryReload({
      deliveries: [],
      linkedProjections: [],
      sessions,
      processByAgent: new Map(),
    });
    expect(snap.byId.size).toBe(0);
    expect(snap.unavailableAgents.has("orphan")).toBe(true);
  });

  it("marker-less crash window: held Delivery with projection but no binding → unavailable + deny holder", () => {
    // Cross-store crash: Delivery + Git projection durable, bindDelivery never written.
    const wt = tempWorktree();
    const held = baseDelivery({ id: "d-crash" });
    const snap = reconcileDeliveryReload({
      deliveries: [held],
      linkedProjections: [proj("d-crash", wt)],
      sessions: new Map([
        // Ordinary resumable row — no delivery marker.
        ["holder", session({
          cwd: wt,
          worktree: { path: wt, branch: "b", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" },
          resume: { runtime: "claude", sessionId: "s-crash" },
          declared: true,
        })],
      ]),
      processByAgent: new Map([["holder", exactObs()]]),
    });
    expect(snap.byId.get("d-crash")?.class).toBe("unavailable");
    expect(snap.byId.get("d-crash")?.reason).toMatch(/no exact session binding/);
    expect(snap.unavailableAgents.has("holder")).toBe(true);
  });

  it("fails closed when holder lacks process identity or open tail drifts", () => {
    const noProcess = baseDelivery({
      id: "d-np",
      lease: {
        state: "held",
        holder: { segmentId: "seg-1", executionAgent: "holder", executionNonce: "n" },
        expectedHeadSha: "abc",
        changedAt: "t",
      },
    });
    const releasedTail = baseDelivery({
      id: "d-rt",
      segments: [{
        id: "seg-1",
        index: 0,
        role: "implementer",
        executionAgent: "holder",
        grantedBy: { kind: "system" },
        ownsSubset: [],
        grantedHeadSha: "abc",
        grantedAt: "t",
        releasedAt: "t2",
      }],
    });
    for (const d of [noProcess, releasedTail]) {
      const snap = reconcileDeliveryReload({
        deliveries: [d],
        linkedProjections: [proj(d.id, "/wt")],
        sessions: new Map(),
        processByAgent: new Map(),
      });
      expect(snap.byId.get(d.id)?.class).toBe("unavailable");
    }
  });

  it("does not infer authority from principal/session existence alone", () => {
    const wt = tempWorktree();
    const delivery = baseDelivery({ id: "d-inf" });
    // Wrong agent name with a valid-looking binding to the delivery — not the holder executionAgent.
    const sessions = new Map([
      ["other", goodSession("d-inf", wt)],
    ]);
    const snap = reconcileDeliveryReload({
      deliveries: [delivery],
      linkedProjections: [proj("d-inf", wt)],
      sessions,
      processByAgent: new Map([["other", exactObs()]]),
    });
    expect(snap.byId.get("d-inf")?.class).toBe("unavailable");
    expect(snap.byId.get("d-inf")?.reason).toMatch(/not the holder|no exact session binding|duplicate/i);
  });

  it("readLinuxProcessIdentity returns exact identity for the current process on Linux", () => {
    if (!fs.existsSync("/proc/self/stat")) return; // non-Linux hosts skip
    const obs = readLinuxProcessIdentity(process.pid);
    expect(obs.state).toBe("exact");
    if (obs.state === "exact") {
      expect(obs.pid).toBe(process.pid);
      expect(obs.processStart).toMatch(/^\d+$/);
      expect(obs.bootId.length).toBeGreaterThan(0);
      // Re-read matches (stable for a live process)
      expect(readLinuxProcessIdentity(process.pid)).toEqual(obs);
    }
  });

  it("readLinuxProcessIdentity returns gone for a never-used pid and unknown for invalid pid", () => {
    if (!fs.existsSync("/proc")) return;
    expect(readLinuxProcessIdentity(2_147_000_000).state).toBe("gone");
    expect(readLinuxProcessIdentity(-1).state).toBe("unknown");
  });
});
