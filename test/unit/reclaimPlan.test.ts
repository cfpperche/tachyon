import { describe, it, expect } from "vitest";
import { planReclaim, summarizeReclaimPlan, type ReclaimInput } from "@tachyon/engine/reclaim/reclaimPlan.js";
import { buildWorkspaceProvenance, parseWorkspaceProvenance, verifyProvenance } from "@tachyon/engine/reclaim/provenance.js";

/**
 * t-f5769a — measured on one machine, 2026-08-22: ~5.0GB of machine-local state nothing collected,
 * and 217 engine states whose owner could not be determined at all.
 */

const NOW = new Date("2026-08-22T12:00:00.000Z");

function input(over: Partial<ReclaimInput> = {}): ReclaimInput {
  return {
    bundles: [],
    liveBundleIds: new Set(),
    keepBundles: 3,
    runtimes: [],
    engineStates: [],
    worktrees: [],
    bridgeTokens: [],
    liveWorkspaceHashes: new Set(),
    deadWorkspaceHashes: new Set(),
    probe: { rootExists: () => true, identityAt: () => undefined },
    ...over,
  };
}

const bundle = (id: string, mtimeMs: number, bytes = 5_000_000) => ({ id, path: `/bundles/${id}`, bytes, mtimeMs });

describe("planReclaim — bundles", () => {
  it("keeps the running bundle and the newest N, collects the rest", () => {
    const bundles = [bundle("old1", 1), bundle("old2", 2), bundle("b3", 3), bundle("b4", 4), bundle("b5", 5)];
    const plan = planReclaim(input({ bundles, keepBundles: 3, liveBundleIds: new Set(["old1"]) }));

    expect(plan.collect.map((c) => c.path)).toEqual(["/bundles/old2"]);
    expect(plan.hold.map((h) => h.path).sort()).toEqual(["/bundles/b3", "/bundles/b4", "/bundles/b5", "/bundles/old1"]);
    // the running one is held for BEING running, not for being recent
    expect(plan.hold.find((h) => h.path === "/bundles/old1")?.reason).toContain("running engine");
  });

  it("never collects a running bundle, however old", () => {
    const bundles = Array.from({ length: 50 }, (_, i) => bundle(`b${i}`, i));
    const plan = planReclaim(input({ bundles, keepBundles: 3, liveBundleIds: new Set(["b0"]) }));
    expect(plan.collect.some((c) => c.path === "/bundles/b0")).toBe(false);
    expect(plan.bytesCollectable).toBe(46 * 5_000_000);
  });

  it("keeps at least one bundle even when asked for zero", () => {
    const plan = planReclaim(input({ bundles: [bundle("a", 1), bundle("b", 2)], keepBundles: 0 }));
    expect(plan.hold).toHaveLength(1);
    expect(plan.hold[0]!.path).toBe("/bundles/b");
  });
});

describe("planReclaim — engine state ownership", () => {
  const state = (hash: string, provenance?: ReturnType<typeof buildWorkspaceProvenance>) => ({
    hash,
    path: `/state/${hash}`,
    bytes: 1_000,
    provenance,
  });

  it("holds state whose workspace is still there", () => {
    const plan = planReclaim(input({
      engineStates: [state("h1", buildWorkspaceProvenance("/ws", "id-1", NOW))],
      probe: { rootExists: () => true, identityAt: () => "id-1" },
    }));
    expect(plan.quarantine).toEqual([]);
    expect(plan.hold[0]!.reason).toContain("still there");
  });

  it("quarantines — never deletes — state of a workspace that is gone", () => {
    const plan = planReclaim(input({
      engineStates: [state("h1", buildWorkspaceProvenance("/gone", "id-1", NOW))],
      probe: { rootExists: () => false, identityAt: () => undefined },
    }));
    expect(plan.collect).toEqual([]);
    expect(plan.quarantine).toHaveLength(1);
    expect(plan.quarantine[0]!.reason).toContain("/gone");
  });

  it("quarantines state whose path now holds a different workspace", () => {
    const plan = planReclaim(input({
      engineStates: [state("h1", buildWorkspaceProvenance("/ws", "id-old", NOW))],
      probe: { rootExists: () => true, identityAt: () => "id-new" },
    }));
    expect(plan.quarantine[0]!.reason).toContain("different workspace");
  });

  it("NEVER touches state with no provenance — guessing here deletes provider keys", () => {
    const plan = planReclaim(input({
      engineStates: [state("legacy")],
      probe: { rootExists: () => false, identityAt: () => undefined },
    }));
    expect(plan.collect).toEqual([]);
    expect(plan.quarantine).toEqual([]);
    expect(plan.hold[0]!.reason).toContain("no provenance recorded yet");
  });
});

describe("planReclaim — worktrees hold unsaved work", () => {
  const worktree = (over: Partial<Parameters<typeof planReclaim>[0]["worktrees"][number]>) => ({
    path: "/wt/x",
    bytes: 10_000_000,
    workspaceHash: "h",
    dirty: false,
    unmerged: false,
    live: false,
    ...over,
  });

  it("collects an orphaned worktree with nothing unsaved", () => {
    const plan = planReclaim(input({ worktrees: [worktree({})] }));
    expect(plan.collect).toHaveLength(1);
  });

  it("refuses to collect a dirty or unmerged worktree, and says why", () => {
    const plan = planReclaim(input({
      worktrees: [worktree({ path: "/wt/dirty", dirty: true }), worktree({ path: "/wt/ahead", unmerged: true })],
    }));
    expect(plan.collect).toEqual([]);
    expect(plan.hold.map((h) => h.reason)).toEqual([
      "holds uncommitted changes — review before removing",
      "holds commits that were never merged — review before removing",
    ]);
  });

  it("never collects a worktree its workspace still owns", () => {
    const plan = planReclaim(input({ worktrees: [worktree({ live: true })] }));
    expect(plan.collect).toEqual([]);
  });
});

describe("planReclaim — bridge tokens are authentication material", () => {
  const tokens = [
    { path: "/gs/bridge-token-live", bytes: 100, hash: "live" },
    { path: "/gs/bridge-token-dead", bytes: 100, hash: "dead" },
    { path: "/gs/bridge-token-unknown", bytes: 100, hash: "unstamped" },
  ];

  it("collects a token only when its workspace is PROVEN gone", () => {
    const plan = planReclaim(input({
      bridgeTokens: tokens,
      liveWorkspaceHashes: new Set(["live"]),
      deadWorkspaceHashes: new Set(["dead"]),
    }));
    expect(plan.collect.map((c) => c.path)).toEqual(["/gs/bridge-token-dead"]);
  });

  it("keeps a token it cannot prove dead — the default that used to be inverted", () => {
    // t-63955f: the rule was "collect unless provably live". Liveness comes from provenance, and on
    // a real machine 216 of 217 states carried none — so turning the automatic pass on would have
    // deleted the authentication material of workspaces that were merely unstamped.
    const plan = planReclaim(input({ bridgeTokens: tokens, liveWorkspaceHashes: new Set(), deadWorkspaceHashes: new Set() }));
    expect(plan.collect).toEqual([]);
    expect(plan.hold).toHaveLength(3);
    expect(plan.hold[0]!.reason).toContain("cannot be shown to belong to a dead workspace");
  });
});

describe("provenance", () => {
  it("round-trips through the state store", () => {
    const built = buildWorkspaceProvenance("/ws", "id-1", NOW);
    expect(parseWorkspaceProvenance(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it("rejects a malformed or future-schema stamp instead of trusting it", () => {
    expect(parseWorkspaceProvenance({ schemaVersion: 2, root: "/ws" })).toBeUndefined();
    expect(parseWorkspaceProvenance({ schemaVersion: 1, root: "" })).toBeUndefined();
    expect(parseWorkspaceProvenance(undefined)).toBeUndefined();
  });

  it("a stamp older than workspace identity stays live while its path exists", () => {
    const legacy = { schemaVersion: 1 as const, root: "/ws", lastSeenAt: NOW.toISOString() };
    expect(verifyProvenance(legacy, { rootExists: () => true, identityAt: () => "whatever" })).toEqual({ kind: "live" });
    expect(verifyProvenance(legacy, { rootExists: () => false, identityAt: () => undefined })).toEqual({ kind: "workspace-gone" });
  });
});

describe("summarizeReclaimPlan", () => {
  it("reads as one line per kind, with quarantine named as kept", () => {
    const plan = planReclaim(input({
      bundles: [bundle("a", 1), bundle("b", 2), bundle("c", 3), bundle("d", 4)],
      keepBundles: 3,
      engineStates: [{ hash: "h", path: "/state/h", bytes: 2_000_000, provenance: buildWorkspaceProvenance("/gone", "x", NOW) }],
      worktrees: [{ path: "/wt/d", bytes: 1, workspaceHash: "h", dirty: true, unmerged: false, live: false }],
      probe: { rootExists: () => false, identityAt: () => undefined },
    }));
    const lines = summarizeReclaimPlan(plan);
    expect(lines[0]).toContain("remove 1 bundle(s)");
    expect(lines.some((line) => line.includes("quarantine 1 engine state(s)") && line.includes("kept, not deleted"))).toBe(true);
    expect(lines.some((line) => line.includes("1 worktree(s) left alone"))).toBe(true);
  });
});
