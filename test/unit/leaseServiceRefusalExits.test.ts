import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryLeaseService } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { Delivery, DeliveryCreateInput, DeliveryLeaseState } from "../../src/delivery/types.js";
import { makeTempDir } from "../helpers/tempDir.js";

/**
 * t-2600f8 — the refusal a CALLER receives names a reachable exit, for every state that refuses.
 *
 * t-cc6495 fixed this shape in `verificationLease.occupied()` by reading `LEASE_DISPOSITION`
 * instead of inlining the state list. The sibling service kept the inlined
 * `["held", "quarantined"]`, so the states its own guards refuse most often — `pending`,
 * `draining`, `verifying` — produced a refusal with no way forward. That reach is wider here, not
 * narrower: `occupied()` has ~35 call sites in leaseService against one in verificationLease.
 *
 * These cases drive the REAL service into each state and assert on what the caller is handed,
 * rather than re-testing the map (test/unit/leaseDisposition.test.ts owns that). A dead end is only
 * a dead end at the point someone hits it.
 */

const now = "2026-07-11T14:00:00.000Z";
const actor = { kind: "agent" as const, name: "coordinator" };

function fixture() {
  const root = makeTempDir("tachyon-refusal-exit-");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  const store = new DeliveryStore(root, { now: () => now });
  const input: DeliveryCreateInput = {
    id: "d-lease", workspaceId: "ws", createdBy: actor,
    contract: { baseSha: "a", behaviorTest: "behavior", owns: ["src"], taskRef: "task" },
    segments: [{
      id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
      ownsSubset: ["src"], grantedHeadSha: "b", grantedAt: now,
    }],
    events: [],
  };
  return { root, worktree, store, input };
}

function service(store: DeliveryStore, worktree: string) {
  return new DeliveryLeaseService({
    store, processObserver: { observe: async () => ({ state: "alive" }) },
    canonicalWorktreeFor: () => worktree,
    readHead: () => "b",
    inspectWorktree: () => ({ headSha: "b", clean: true }),
    isAncestor: () => true,
    withWorktreeLock: async (_path, fn) => fn(),
    now: () => now, nonce: () => "nonce", segmentId: () => "seg-1", eventId: () => "event-1",
  });
}

/** The refusal a contender gets when the lease already sits in `state`. */
async function refusalFor(state: DeliveryLeaseState): Promise<{ code: string; detail?: Record<string, unknown> }> {
  const { store, worktree, input } = fixture();
  input.lease = leaseFor(state);
  await store.create(input);
  try {
    await service(store, worktree).acquire({
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"],
      operationId: `contend-${state}`,
    });
  } catch (error) {
    return error as { code: string; detail?: Record<string, unknown> };
  }
  throw new Error(`acquire against a '${state}' lease was expected to refuse, but succeeded`);
}

function leaseFor(state: DeliveryLeaseState): Delivery["lease"] {
  const holder = { segmentId: "seg-0", executionAgent: "worker",
    process: { pid: 7, processStart: "10", bootId: "boot" }, executionNonce: "exec-0" };
  if (state === "verifying") {
    return { state, changedAt: now, verification: { nonce: "n", ownerEpoch: "e", actor,
      subjectSegmentId: "seg-0", deliveredHeadSha: "b", startedAt: now, operationId: "verify",
      priorLease: { state: "free", changedAt: now } } };
  }
  if (state === "pending") return { state, holder: { ...holder, reservationNonce: "res-0" }, expectedHeadSha: "b", changedAt: now };
  return { state, holder, expectedHeadSha: "b", changedAt: now };
}

describe("lease service refusals name a reachable exit (t-2600f8)", () => {
  it("tells a caller blocked by a HELD lease why no exit remains", async () => {
    // Control case: this one already worked before the fix, and must keep working after it. A case
    // that holds in BOTH states is what proves the fix added an exit rather than moving one.
    const refusal = await refusalFor("held");
    expect(refusal.code).toBe("WORKTREE_OCCUPIED");
    expect(refusal.detail).toMatchObject({ state: "held", next: { retry: false, why: expect.stringContaining("retired") } });
  });

  it("tells a caller blocked by a QUARANTINED lease why no exit remains", async () => {
    const refusal = await refusalFor("quarantined");
    expect(refusal.detail).toMatchObject({ state: "quarantined", next: { retry: false, why: expect.stringContaining("retired") } });
  });

  it("tells a caller blocked by a VERIFYING lease why no exit remains", async () => {
    // Salvage on a live verification would discard a run that may still be legitimately in flight,
    // so the exit for a stuck verification is reconciliation. Before the fix: no exit at all.
    const refusal = await refusalFor("verifying");
    expect(refusal.detail).toMatchObject({ state: "verifying", next: { retry: false, why: expect.stringContaining("retired") } });
  });

  it.each(["pending", "draining"] as const)("tells a caller blocked by a %s lease that it clears on its own", async (state) => {
    // Transitional states have no operator action, and that is the point: "retry, here is why" is a
    // different answer from silence. Silence is what sends someone to raw git (t-0cbcbd).
    const refusal = await refusalFor(state);
    expect(refusal.detail).toMatchObject({ state, next: { retry: true } });
    expect(String((refusal.detail?.next as { why?: string })?.why ?? "").length).toBeGreaterThan(0);
  });

  it("leaves no refusing state without an exit", async () => {
    // The sweep the per-state cases above would miss if a state were added later: every state that
    // actually refuses must carry `next`. Reads the states from the type, never a copy.
    const declared = declaredStates().filter((state) => state !== "free" && state !== "abandoned");
    expect(declared.length).toBeGreaterThan(0);
    for (const state of declared) {
      const refusal = await refusalFor(state);
      expect(refusal.detail?.next, `a '${state}' lease refuses with no way forward`).toBeTruthy();
    }
  });
});

/** The `DeliveryLeaseState` union, parsed from its declaration — see leaseDisposition.test.ts. */
function declaredStates(): DeliveryLeaseState[] {
  const src = fs.readFileSync(path.resolve(__dirname, "../../src/delivery/types.ts"), "utf8");
  const line = src.split("\n").find((l) => l.includes("export type DeliveryLeaseState"));
  if (!line) throw new Error("DeliveryLeaseState declaration not found — this test reads it, it does not own it");
  return [...line.matchAll(/"([a-z]+)"/g)].map((m) => m[1] as DeliveryLeaseState);
}
