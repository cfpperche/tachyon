import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryStore } from "../../src/delivery/store.js";
import { DeliveryVerificationLeaseService } from "../../src/delivery/verificationLease.js";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";
import type { DeliveryLease, DeliveryVerificationIntent, DelegationSegment } from "../../src/delivery/types.js";

const roots: string[] = [];
const actor = { kind: "agent" as const, name: "coordinator" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeCommit(cwd: string, file: string, body: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), body);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(options: { segments?: DelegationSegment[]; lease?: DeliveryLease; multiTail?: boolean;
  canonicalSpawnPrincipalOmission?: boolean; canonicalSpawnAttested?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-verification-lease-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  const base = writeCommit(root, "src/base.ts", "base\n", "base");
  git(root, "branch", "task");
  const worktree = path.join(root, "wt");
  git(root, "worktree", "add", worktree, "task");
  const delivered = writeCommit(worktree, "src/feature.ts", "feature\n", "t-0b5723 feature");
  const store = new DeliveryStore(root);
  const gitDeliveries = new GitDeliveryStore(root, { id: () => "gd-verify" });
  const deliveryId = options.canonicalSpawnPrincipalOmission ? "d-spawn-known-writer" : "d-verify";
  const projection = await gitDeliveries.open({ workspaceId: "ws", createdBy: actor, deliveryId, agent: "tail",
    branchRef: "task", worktreePath: worktree, tachyonCreatedBranch: true, baseRef: base, currentHeadSha: delivered });
  const defaultSegments: DelegationSegment[] = [{ id: "seg-0", index: 0, role: "implementer", executionAgent: "tail",
    grantedBy: actor, ownsSubset: ["src"], grantedHeadSha: base, grantedAt: "2026-07-11T00:00:00.000Z",
    releasedAt: "2026-07-11T00:01:00.000Z", releasedHeadSha: delivered, outcome: "completed" }];
  const segments = options.multiTail ? [
    { ...defaultSegments[0]!, executionAgent: "dead-zero", releasedHeadSha: base },
    { id: "seg-1", index: 1, role: "fixer" as const, executionAgent: "live-tail", grantedBy: actor, ownsSubset: ["src"],
      grantedHeadSha: base, grantedAt: "2026-07-11T00:00:30.000Z", releasedAt: "2026-07-11T00:01:00.000Z",
      releasedHeadSha: delivered, outcome: "completed" as const },
  ] : options.canonicalSpawnPrincipalOmission
    ? [{ ...defaultSegments[0]!, principal: "tail", releasedAt: undefined, releasedHeadSha: undefined, outcome: undefined }]
    : options.segments ?? defaultSegments;
  const lease = options.canonicalSpawnPrincipalOmission
    ? { state: "held" as const, holder: { segmentId: "seg-0", executionAgent: "tail",
      process: { pid: 42, processStart: "100", bootId: "boot" }, executionNonce: "execution" },
      expectedHeadSha: delivered, changedAt: "2026-07-11T00:01:00.000Z" }
    : options.lease ?? { state: "free" as const, changedAt: "2026-07-11T00:01:00.000Z" };
  await store.create({ id: deliveryId, workspaceId: "ws", createdBy: actor,
    contract: { baseSha: base, behaviorTest: "behavior", owns: ["src"], taskRef: "task" },
    segments, lease,
    events: options.canonicalSpawnPrincipalOmission && options.canonicalSpawnAttested !== false ? [{ id: "projection-event", at: "2026-07-11T00:00:30.000Z",
      type: "projection.intent", by: actor,
      detail: { action: "open", gitDeliveryId: projection.id, payload: { reason: "canonical gated spawn" } } }] : [],
    gitDeliveryId: projection.id });
  return { root, worktree, base, delivered, store, gitDeliveries, projection, deliveryId };
}

function service(f: Awaited<ReturnType<typeof fixture>>, options: { epoch?: string; running?: (name: string) => boolean } = {}) {
  return new DeliveryVerificationLeaseService({ store: f.store, gitDeliveries: f.gitDeliveries,
    ownerEpoch: options.epoch ?? "epoch-current", withPathLock: async (_path, fn) => fn(),
    isAgentRunning: async (name) => options.running?.(name) ?? false,
    nonce: () => "verify-nonce", operationId: () => "verify-operation", now: () => "2026-07-11T01:00:00.000Z",
    eventId: (() => { let n = 0; return () => `verify-event-${++n}`; })() });
}

async function seedInterrupted(f: Awaited<ReturnType<typeof fixture>>, temporaryCheckoutSha?: string) {
  const current = (await f.store.get("d-verify"))!;
  const priorLease = structuredClone(current.lease) as DeliveryVerificationIntent["priorLease"];
  const intent: DeliveryVerificationIntent = { nonce: "old-nonce", ownerEpoch: "epoch-old", actor,
    subjectSegmentId: current.segments.at(-1)!.id, deliveredHeadSha: f.delivered,
    ...(temporaryCheckoutSha ? { temporaryCheckoutSha } : {}), startedAt: "2026-07-11T00:30:00.000Z",
    operationId: "old-operation", priorLease };
  await f.store.update(current.id, current.version, (record) => {
    record.lease = { state: "verifying", ...(priorLease.holder ? { holder: structuredClone(priorLease.holder) } : {}),
      ...(priorLease.expectedHeadSha ? { expectedHeadSha: priorLease.expectedHeadSha } : {}),
      changedAt: intent.startedAt, verification: intent };
    return record;
  });
  return intent;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DeliveryVerificationLeaseService (SDD 368 T9)", () => {
  it("refuses terminal abandoned Deliveries without retryable occupancy", async () => {
    const f = await fixture();
    const current = (await f.store.get("d-verify"))!;
    await f.store.update(current.id, current.version, (record) => {
      record.lease = { state: "abandoned", changedAt: "2026-07-11T00:02:00.000Z" };
      return record;
    });
    await expect(service(f).run("d-verify", actor, async () => { throw new Error("must not execute"); }))
      .rejects.toMatchObject({ code: "DELIVERY_ABANDONED", retryable: false });
  });

  it("checks current tail liveness while dead segment zero is irrelevant", async () => {
    const f = await fixture({ multiTail: true });
    let executed = false;
    await expect(service(f, { running: (name) => name === "live-tail" }).run("d-verify", actor, async () => {
      executed = true; throw new Error("must not execute");
    })).rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true,
      detail: { next: { action: "kill_agent", name: "live-tail", then: "retry verify_task with the same delivery_id" } } });
    expect(executed).toBe(false);
    expect((await f.store.get("d-verify"))!.lease.state).toBe("free");
  });

  it("repairs the attested canonical-spawn principal omission and verifies after the tail stops", async () => {
    const f = await fixture({ canonicalSpawnPrincipalOmission: true });
    const result = await service(f).run(f.deliveryId, actor, async () => ({ publish: async () => ({
      result: "accepted",
      evidence: { refSha: f.delivered, treeSha: git(f.worktree, "rev-parse", "HEAD^{tree}"),
        verdict: "accept", integrityHash: "hash", recordPath: "record" },
    }) }));
    expect(result).toBe("accepted");
    const repaired = (await f.store.get(f.deliveryId))!;
    expect(repaired.lease.holder).toMatchObject({ executionAgent: "tail", principal: "tail" });
    expect(repaired.events.map((event) => event.type)).toEqual([
      "projection.intent", "canonical_spawn_principal_repaired", "verification_started", "verification_completed",
    ]);
  });

  it("does not infer a missing holder principal without the canonical-spawn attestation", async () => {
    const f = await fixture({ canonicalSpawnPrincipalOmission: true, canonicalSpawnAttested: false });

    await expect(service(f).run(f.deliveryId, actor, async () => { throw new Error("must not execute"); }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    const refused = (await f.store.get(f.deliveryId))!;
    expect(refused.lease.holder?.principal).toBeUndefined();
    expect(refused.events).toEqual([]);
  });

  it("allows one verifying CAS and refuses a same-epoch contender before checkout", async () => {
    const f = await fixture();
    const verifier = service(f);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const acquired = new Promise<void>((resolve) => { started = resolve; });
    const first = verifier.run("d-verify", actor, async () => {
      started(); await held;
      return { publish: async () => ({ result: "first", evidence: { refSha: f.delivered, treeSha: git(f.worktree, "rev-parse", "HEAD^{tree}"),
        verdict: "accept", integrityHash: "hash", recordPath: "record" } }) };
    });
    await acquired;
    let loserExecuted = false;
    await expect(verifier.run("d-verify", actor, async () => { loserExecuted = true; throw new Error("loser"); }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED" });
    expect(loserExecuted).toBe(false);
    release();
    await expect(first).resolves.toBe("first");
  });

  it.each([false, true])("restores an interrupted clean checkout (temporary=%s) and records retryable interruption", async (temporary) => {
    const f = await fixture();
    await seedInterrupted(f, temporary ? f.base : undefined);
    if (temporary) git(f.worktree, "checkout", "--detach", "--force", f.base);
    await expect(service(f).run("d-verify", actor, async () => { throw new Error("must retry"); }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    const restored = (await f.store.get("d-verify"))!;
    expect(restored.lease.state).toBe("free");
    expect(restored.events.at(-1)).toMatchObject({ type: "verification_interrupted", detail: { retryable: true } });
    expect(git(f.worktree, "symbolic-ref", "--short", "HEAD")).toBe("task");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.delivered);
  });

  it.each(["dirty", "third-head", "branch-moved"] as const)("quarantines unsafe interrupted recovery: %s", async (kind) => {
    const f = await fixture();
    await seedInterrupted(f, kind === "third-head" ? f.base : undefined);
    if (kind === "dirty") fs.writeFileSync(path.join(f.worktree, "dirty.txt"), "dirty\n");
    if (kind === "third-head") {
      git(f.worktree, "checkout", "--detach", "--force", f.base);
      writeCommit(f.worktree, "src/third.ts", "third\n", "third detached head");
    }
    if (kind === "branch-moved") writeCommit(f.worktree, "src/moved.ts", "moved\n", "move task");
    await expect(service(f).run("d-verify", actor, async () => { throw new Error("must not execute"); }))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await f.store.get("d-verify"))!.lease.state).toBe("quarantined");
  });

  it("quarantines linked projection drift during interrupted recovery", async () => {
    const f = await fixture();
    await seedInterrupted(f);
    await f.gitDeliveries.applyCanonicalIntent({ id: f.projection.id, expectedVersion: f.projection.version,
      sequence: 1, operationId: "fixture-branch-drift", deliveryId: "d-verify",
      mutate: (record) => ({ ...record, branchRef: "wrong" }) });
    await expect(service(f).run("d-verify", actor, async () => { throw new Error("must not execute"); }))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await f.store.get("d-verify"))!.lease.state).toBe("quarantined");
  });

  it("refuses a linked GitDelivery workspace drift before checkout or callback execution", async () => {
    const f = await fixture();
    await f.gitDeliveries.applyCanonicalIntent({ id: f.projection.id, expectedVersion: f.projection.version,
      sequence: 1, operationId: "fixture-workspace-drift", deliveryId: "d-verify",
      mutate: (record) => ({ ...record, workspaceId: "other-workspace" }) });
    const before = git(f.worktree, "rev-parse", "HEAD");
    let executed = false;
    await expect(service(f).run("d-verify", actor, async () => {
      executed = true;
      throw new Error("must not execute");
    })).rejects.toThrow("GitDelivery projection drift");
    expect(executed).toBe(false);
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(before);
    expect((await f.store.get("d-verify"))!.lease.state).toBe("free");
  });

  it("preserves a prior held holder, process identity, nonce, and expected HEAD through unsafe recovery quarantine", async () => {
    const heldLease: DeliveryLease = { state: "held", holder: { segmentId: "seg-0", executionAgent: "tail", principal: "principal",
      process: { pid: 42, processStart: "100", bootId: "boot" }, executionNonce: "execution-nonce" },
      expectedHeadSha: "expected-head", changedAt: "2026-07-11T00:01:00.000Z" };
    const f = await fixture({ lease: heldLease });
    await seedInterrupted(f, f.base);
    git(f.worktree, "checkout", "--detach", "--force", f.base);
    fs.writeFileSync(path.join(f.worktree, "dirty-held.txt"), "dirty\n");
    await expect(service(f).run("d-verify", actor, async () => { throw new Error("must not execute"); }))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    const quarantined = (await f.store.get("d-verify"))!;
    expect(quarantined.lease).toMatchObject({ state: "quarantined", holder: heldLease.holder,
      expectedHeadSha: heldLease.expectedHeadSha });
    expect(quarantined.lease.holder).toEqual(heldLease.holder);
    expect(quarantined.events.at(-1)).toMatchObject({ type: "verification_quarantined", detail: {
      operationId: "old-operation", subjectSegmentId: "seg-0", ownerEpoch: "epoch-old",
      verificationActor: actor, priorLeaseState: "held", deliveredHeadSha: f.delivered,
      temporaryCheckoutSha: f.base,
      reason: expect.stringContaining("interrupted verification recovery failed"),
    } });
  });

  it("restores the exact prior held lease before publication and records completion integrity", async () => {
    const heldLease: DeliveryLease = { state: "held", holder: { segmentId: "seg-0", executionAgent: "tail",
      process: { pid: 1, processStart: "1", bootId: "boot" }, executionNonce: "execution" }, expectedHeadSha: "unused",
      changedAt: "2026-07-11T00:01:00.000Z" };
    const f = await fixture({ lease: heldLease });
    const result = await service(f).run("d-verify", actor, async (context) => {
      await context.runAtSha(f.base, async () => expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.base));
      return { publish: async () => {
        expect(git(f.worktree, "symbolic-ref", "--short", "HEAD")).toBe("task");
        expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.delivered);
        return { result: "accepted", evidence: { refSha: f.delivered, treeSha: "tree", verdict: "accept",
          integrityHash: "integrity", recordPath: ".tachyon/verifications/record.json" } };
      } };
    });
    expect(result).toBe("accepted");
    const completed = (await f.store.get("d-verify"))!;
    expect(completed.lease).toMatchObject({ ...heldLease, changedAt: "2026-07-11T01:00:00.000Z" });
    expect(completed.events.at(-1)).toMatchObject({ type: "verification_completed",
      detail: { integrityHash: "integrity", recordPath: ".tachyon/verifications/record.json" } });
  });

  it("preserves original, restore, and quarantine-persistence failures without claiming quarantine", async () => {
    const f = await fixture();
    const update = f.store.update.bind(f.store);
    let refusePersistence = false;
    f.store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      if (refusePersistence) throw new Error("quarantine persistence failed");
      return update(...args);
    };
    const error = await service(f).run("d-verify", actor, async (context) => {
      await context.runAtSha(f.base, async () => {
        fs.writeFileSync(path.join(f.worktree, "dirty-after-failure.txt"), "dirty\n");
        refusePersistence = true;
        throw new Error("verification callback failed");
      });
      throw new Error("unreachable");
    }).catch((caught) => caught) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).not.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect(error.errors.map((item) => item instanceof Error ? item.message : String(item))).toEqual([
      "verification callback failed",
      expect.stringContaining("worktree is not a clean recorded verification checkout"),
      "quarantine persistence failed",
    ]);
    expect((await f.store.get("d-verify"))!.lease.state).toBe("verifying");
  });
});
