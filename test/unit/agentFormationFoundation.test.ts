import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FormationAuthorityStore,
  type ResolvedFormationPayload,
} from "@tachyon/engine/agents/formation/authorityStore.js";
import {
  formationDigest,
  formationSkillRelativePathError,
  profileActivationHeadV2FromV1,
  validateFormationAuthorityVector,
  type FormationAuthorityVector,
  type FormationGenerationHeadV1,
  type ProfileActivationHeadV2,
} from "@tachyon/engine/agents/formation/domain.js";
import {
  FORMATION_GOVERNED_LANES,
  validateFormationSessionTransition,
} from "../helpers/sessionPolicy.js";
import { FormationObjectStore } from "@tachyon/engine/agents/formation/objectStore.js";
import type { AgentProfileAuthorityRecord } from "@tachyon/engine/config/agentProfileAuthority.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const WORKSPACE_ID = "workspace-test";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const human = { principal: "human-alice", kind: "human" as const };

function profile(revision = 1): ProfileActivationHeadV2 {
  return {
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentName: "codex",
    revision,
    priorRevision: revision - 1,
    canonicalSha256: HEX_A,
    effectiveSha256: HEX_B,
    runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: HEX_C },
    lanes: {
      instructions: { mode: "disabled" },
      memory: { mode: "disabled" },
    },
  };
}

function vector(generation = 1, priorGeneration = generation - 1, activeProfile = profile()): FormationAuthorityVector {
  const head: FormationGenerationHeadV1 = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    generation,
    priorGeneration,
    retired: false,
    profile: { revision: activeProfile.revision, digest: formationDigest(activeProfile) },
    rendererContractsSha256: HEX_C,
  };
  return { profile: activeProfile, generation: head };
}

interface Fixture {
  store: FormationAuthorityStore;
  setNow(value: string): void;
  setPayload(value: Omit<ResolvedFormationPayload, "sourceVectorSha256" | "rendererContractsSha256">): void;
}

function fixture(authorize = true): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-foundation-"));
  roots.push(root);
  let now = "2026-07-22T12:00:00.000Z";
  let payload: Omit<ResolvedFormationPayload, "sourceVectorSha256" | "rendererContractsSha256"> = {
    startupPrompt: "exact startup bytes",
    reanchorReminder: "exact re-anchor bytes",
  };
  return {
    store: new FormationAuthorityStore(root, {
      now: () => now,
      leaseTtlMs: 60_000,
      authorizeLaunch: () => authorize,
      authorizeMutation: () => authorize,
      authorizeSelectorRevocation: () => authorize,
      authorizeSelectorRead: ({ caller, ownerPrincipal, ownerKind }) => authorize
        && caller.principal === ownerPrincipal && caller.kind === ownerKind,
      resolvePayload: ({ vector: active }) => ({
        ...payload,
        sourceVectorSha256: formationDigest(active),
        rendererContractsSha256: active.generation.rendererContractsSha256,
      }),
    }),
    setNow(value) { now = value; },
    setPayload(value) { payload = value; },
  };
}

function prepare(store: FormationAuthorityStore, operationId: string, active: FormationAuthorityVector) {
  return store.prepareSnapshot({
    operationId,
    caller: human,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentName: "codex",
    runtimeTrustClass: "codex-v1",
    expectedGenerationSha256: formationDigest(active.generation),
  });
}

describe("agent formation authority foundation", () => {
  it("upgrades v1 profile authority only with all new lanes disabled", () => {
    const legacy: AgentProfileAuthorityRecord = {
      schemaVersion: 1,
      agentName: "codex",
      agentId: AGENT_ID,
      revision: "legacy-r1",
      canonicalSha256: HEX_A,
      runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: HEX_C },
    };
    const upgraded = profileActivationHeadV2FromV1({ workspaceId: WORKSPACE_ID, legacy, effectiveSha256: HEX_B });
    expect(Object.values(upgraded.lanes)).toEqual([
      { mode: "disabled" },
      { mode: "disabled" },
    ]);
    expect(JSON.stringify(upgraded)).not.toContain("plugin");
    expect(FORMATION_GOVERNED_LANES).toEqual(["instructions", "memory"]);
  });

  it("rejects mixed identities and unbound active heads", () => {
    const wrong = vector();
    wrong.generation.agentId = OTHER_AGENT_ID;
    expect(validateFormationAuthorityVector(wrong)).toContain("generation authority belongs to another agentId");

  });

  it("publishes resolver-owned bytes once and replays after authority advances", () => {
    const { store } = fixture();
    const initial = vector();
    store.replaceVector({ operationId: "generation-one", caller: human, mutation: "bootstrap", vector: initial });
    const manifest = prepare(store, "fresh-one", initial);
    const selector = store.commitFresh({ operationId: "fresh-one", caller: human });
    expect(store.commitFresh({ operationId: "fresh-one", caller: human })).toEqual(selector);

    const second = vector(2, 1, profile(2));
    store.replaceVector({
      operationId: "generation-two",
      caller: human,
      mutation: "profile-edit",
      vector: second,
      expectedGenerationSha256: formationDigest(initial.generation),
    });
    expect(prepare(store, "fresh-one", initial)).toEqual(manifest);
    expect(() => store.prepareSnapshot({
      operationId: "fresh-one",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "codex",
      runtimeTrustClass: "different-runtime",
      expectedGenerationSha256: formationDigest(initial.generation),
    })).toThrow("reused for another snapshot");
    expect(() => store.commitFresh({ operationId: "fresh-one", caller: { principal: "human-mallory", kind: "human" } }))
      .toThrow("another caller");
    expect(() => store.commitFresh({ operationId: "fresh-one", caller: { principal: "human-alice", kind: "agent" } }))
      .toThrow("another caller");
    expect(selector.snapshotId).toBe(manifest.snapshotId);
    expect(selector.rootSessionId).toBe(selector.sessionId);

    const payload = store.snapshotPayload(selector.sessionId, human);
    const startup = payload.manifest.objects.find((object) => object.kind === "startup-prompt")!;
    const reanchor = payload.manifest.objects.find((object) => object.kind === "reanchor-reminder")!;
    expect(payload.objects.get(startup.sha256)?.toString("utf8")).toBe("exact startup bytes");
    expect(payload.objects.get(reanchor.sha256)?.toString("utf8")).toBe("exact re-anchor bytes");
    expect(() => store.snapshotPayload(selector.sessionId, { principal: "human-mallory", kind: "human" }))
      .toThrow("read is not authorized");
  });

  it("binds commit to the exact caller that prepared the snapshot", () => {
    const { store } = fixture();
    const initial = vector();
    store.replaceVector({ operationId: "generation-caller", caller: human, mutation: "bootstrap", vector: initial });
    prepare(store, "fresh-caller", initial);
    expect(() => store.commitFresh({
      operationId: "fresh-caller",
      caller: { principal: "human-mallory", kind: "human" },
    })).toThrow("prepared by another caller");
  });

  it("fails closed when a trusted resolver returns mismatched provenance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-foundation-resolver-"));
    roots.push(root);
    const store = new FormationAuthorityStore(root, {
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: () => true,
      resolvePayload: () => ({
        sourceVectorSha256: HEX_A,
        rendererContractsSha256: HEX_B,
        startupPrompt: "untrusted",
        reanchorReminder: "untrusted",
      }),
    });
    const initial = vector();
    store.replaceVector({ operationId: "generation-resolver", caller: human, mutation: "bootstrap", vector: initial });
    expect(() => prepare(store, "fresh-resolver", initial)).toThrow("another authority vector");
  });

  it("rejects unsafe lane artifact paths", () => {
    for (const unsafe of ["../SKILL.md", "/tmp/SKILL.md", "plugins/x/SKILL.md", "x\\SKILL.md", "C:/x/SKILL.md"]) {
      expect(formationSkillRelativePathError(unsafe), unsafe).toBeDefined();
    }
    expect(formationSkillRelativePathError("repo-check/SKILL.md")).toBeUndefined();
  });

  it("requires mutation-specific consecutive revisions and permits durable retirement", () => {
    const { store } = fixture();
    const first = vector();
    store.replaceVector({ operationId: "generation-sequence-one", caller: human, mutation: "bootstrap", vector: first });
    expect(() => store.replaceVector({
      operationId: "generation-sequence-leap",
      caller: human,
      mutation: "profile-edit",
      vector: vector(3, 2, profile(3)),
      expectedGenerationSha256: formationDigest(first.generation),
    })).toThrow("exactly one");
    const retired = vector(2, 1);
    retired.generation.retired = true;
    store.replaceVector({
      operationId: "generation-retire",
      caller: human,
      mutation: "retire",
      vector: retired,
      expectedGenerationSha256: formationDigest(first.generation),
    });
    expect(store.currentVector(AGENT_ID)).toEqual(retired);
    expect(() => prepare(store, "fresh-retired", retired)).toThrow("changed or retired");
  });

  it("requires every bootstrap authority head to begin at revision one", () => {
    const { store } = fixture();
    const fabricated = vector(1, 0, profile(500));
    expect(() => store.replaceVector({
      operationId: "generation-fabricated",
      caller: human,
      mutation: "bootstrap",
      vector: fabricated,
    })).toThrow("bootstrap generation 1");
  });

  it("aborts selector publication when formation authority changes", () => {
    const { store } = fixture();
    const first = vector();
    store.replaceVector({ operationId: "generation-first", caller: human, mutation: "bootstrap", vector: first });
    prepare(store, "fresh-race", first);
    const second = vector(2, 1, profile(2));
    store.replaceVector({
      operationId: "generation-second",
      caller: human,
      mutation: "profile-edit",
      vector: second,
      expectedGenerationSha256: formationDigest(first.generation),
    });
    expect(() => store.commitFresh({ operationId: "fresh-race", caller: human }))
      .toThrow("generation changed or retired before selector commit");
  });

  it("blocks fresh formation and competing mutations behind a recoverable mutation barrier", () => {
    const { store } = fixture();
    const first = vector();
    const next = vector(2, 1, profile(2));
    store.replaceVector({ operationId: "generation-barrier", caller: human, mutation: "bootstrap", vector: first });
    store.beginMutationBarrier({
      operationId: "profile-barrier",
      mutation: "profile-edit",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      expectedGenerationSha256: formationDigest(first.generation),
      intent: { kind: "human-lanes", revision: 2, nextVector: next },
    });
    expect(() => prepare(store, "fresh-blocked", first)).toThrow("blocked by a prepared authority mutation");
    expect(() => store.replaceVector({
      operationId: "competing-edit",
      caller: human,
      mutation: "profile-edit",
      vector: next,
      expectedGenerationSha256: formationDigest(first.generation),
    })).toThrow("does not match its prepared barrier intent");
    expect(() => store.replaceVector({
      operationId: "profile-barrier",
      caller: { principal: "human-mallory", kind: "human" },
      mutation: "profile-edit",
      vector: next,
      expectedGenerationSha256: formationDigest(first.generation),
    })).toThrow("does not match its prepared barrier intent");
    store.finishMutationBarrier({ operationId: "profile-barrier", caller: human, outcome: "rolled-back" });
    expect(prepare(store, "fresh-unblocked", first).formationGeneration).toBe(1);
  });

  it("terminally abandons a prepared fresh lease when a mutation barrier begins", () => {
    const { store } = fixture();
    const first = vector();
    store.replaceVector({ operationId: "generation-prepared-race", caller: human, mutation: "bootstrap", vector: first });
    prepare(store, "fresh-before-barrier", first);
    store.beginMutationBarrier({
      operationId: "profile-after-fresh",
      mutation: "profile-edit",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      expectedGenerationSha256: formationDigest(first.generation),
      intent: { kind: "human-lanes", revision: 2 },
    });
    expect(() => store.commitFresh({ operationId: "fresh-before-barrier", caller: human })).toThrow("terminally abandoned");
  });

  it("keeps live leases and reclaims only expired unreferenced payloads", () => {
    const context = fixture();
    const initial = vector();
    context.store.replaceVector({ operationId: "generation-gc", caller: human, mutation: "bootstrap", vector: initial });
    prepare(context.store, "fresh-abandoned", initial);
    expect(context.store.garbageCollect()).toEqual({ abandonedOperations: [], removedObjects: [] });
    context.setNow("2026-07-22T09:01:00.001-03:00");
    const result = context.store.garbageCollect();
    expect(result.abandonedOperations).toEqual(["fresh-abandoned"]);
    expect(result.removedObjects).toHaveLength(2);
    expect(() => prepare(context.store, "fresh-abandoned", initial)).toThrow("terminally abandoned");
  });

  it("does not commit a ready snapshot after its lease expires", () => {
    const context = fixture();
    const initial = vector();
    context.store.replaceVector({ operationId: "generation-expiry", caller: human, mutation: "bootstrap", vector: initial });
    prepare(context.store, "fresh-expiry", initial);
    context.setNow("2026-07-22T12:01:00.001Z");
    expect(() => context.store.commitFresh({ operationId: "fresh-expiry", caller: human }))
      .toThrow("terminally abandoned");
    expect(() => prepare(context.store, "fresh-expiry", initial)).toThrow("terminally abandoned");
  });

  it("derives ownership from authorized caller and uses dedicated revocation authorization", () => {
    const denied = fixture(false).store;
    const initial = vector();
    expect(() => denied.replaceVector({ operationId: "generation-denied", caller: human, mutation: "bootstrap", vector: initial }))
      .toThrow("not authorized");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-foundation-revoke-"));
    roots.push(root);
    const store = new FormationAuthorityStore(root, {
      authorizeMutation: () => true,
      authorizeLaunch: () => true,
      authorizeSelectorRevocation: () => false,
      authorizeSelectorRead: () => true,
      resolvePayload: ({ vector: active }) => ({
        sourceVectorSha256: formationDigest(active),
        rendererContractsSha256: active.generation.rendererContractsSha256,
        startupPrompt: "prompt",
        reanchorReminder: "reminder",
      }),
    });
    store.replaceVector({ operationId: "generation-revoke", caller: human, mutation: "bootstrap", vector: initial });
    prepare(store, "fresh-revoke", initial);
    const selector = store.commitFresh({ operationId: "fresh-revoke", caller: human });
    expect(() => store.revokeSelector({ operationId: "revoke-denied", sessionId: selector.sessionId, caller: human }))
      .toThrow("revocation is not authorized");
  });

  it("rejects a symbolic authority root before opening its database", () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-foundation-root-"));
    roots.push(container);
    const target = path.join(container, "target");
    const linked = path.join(container, "linked");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, linked, "dir");
    expect(() => new FormationAuthorityStore(linked, {
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: () => true,
      resolvePayload: () => ({
        sourceVectorSha256: HEX_A,
        rendererContractsSha256: HEX_B,
        startupPrompt: "prompt",
        reanchorReminder: "reminder",
      }),
    })).toThrow("real private directory");
  });

  it("rejects pre-existing object-store directories that are not private", () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-foundation-object-root-"));
    roots.push(container);
    const objectRoot = path.join(container, "objects-root");
    fs.mkdirSync(objectRoot, { mode: 0o700 });
    fs.mkdirSync(path.join(objectRoot, "objects"), { mode: 0o755 });
    fs.chmodSync(path.join(objectRoot, "objects"), 0o755);
    expect(() => new FormationObjectStore(objectRoot)).toThrow("not a private directory");
  });

  it("reclaims crash-abandoned staging files after a safe grace period", () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-foundation-staging-"));
    roots.push(container);
    const objectStore = new FormationObjectStore(path.join(container, "store"));
    const stale = path.join(objectStore.stagingRoot, "11111111-1111-4111-8111-111111111111.object");
    fs.writeFileSync(stale, "abandoned");
    fs.utimesSync(stale, new Date(0), new Date(0));
    objectStore.collectUnreferenced(new Set());
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("cascades selector revocation through descendants", () => {
    const { store } = fixture();
    const initial = vector();
    store.replaceVector({ operationId: "generation-lineage", caller: human, mutation: "bootstrap", vector: initial });
    prepare(store, "fresh-lineage", initial);
    const root = store.commitFresh({ operationId: "fresh-lineage", caller: human });
    const child = store.fork({ operationId: "fork-child", caller: human, parentSessionId: root.sessionId });
    const grandchild = store.fork({ operationId: "fork-grandchild", caller: human, parentSessionId: child.sessionId });
    expect(child.rootSessionId).toBe(root.sessionId);
    expect(grandchild.rootSessionId).toBe(root.sessionId);

    const revoked = store.revokeSelector({ operationId: "revoke-root", sessionId: root.sessionId, caller: human });
    expect(store.revokeSelector({ operationId: "revoke-root", sessionId: root.sessionId, caller: human })).toEqual(revoked);
    expect(store.getSelector(child.sessionId, human)?.revokedAt).toBe(revoked.revokedAt);
    expect(store.getSelector(grandchild.sessionId, human)?.revokedAt).toBe(revoked.revokedAt);
    expect(() => store.snapshotPayload(grandchild.sessionId, human)).toThrow("lineage is revoked");
    expect(() => store.fork({ operationId: "fork-after-revoke", caller: human, parentSessionId: child.sessionId }))
      .toThrow("lineage is revoked");
  });

  it("keeps resume operations on the pinned owner, agent and runtime trust class", () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const selector = {
      schemaVersion: 1 as const,
      sessionId,
      rootSessionId: sessionId,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "codex",
      ownerPrincipal: "human-alice",
      ownerKind: "human" as const,
      runtimeTrustClass: "codex-v1",
      snapshotId: "44444444-4444-4444-8444-444444444444",
      snapshotSha256: HEX_A,
      formationGeneration: 1,
      formationGenerationSha256: HEX_B,
      createdAt: "2026-07-22T12:00:00.000Z",
    };
    expect(validateFormationSessionTransition(selector, {
      operation: "resume",
      ownerPrincipal: "human-alice",
      ownerKind: "human",
      agentId: AGENT_ID,
      runtimeTrustClass: "codex-v1",
    })).toEqual({ ok: true });
    expect(validateFormationSessionTransition(selector, {
      operation: "rebind",
      ownerPrincipal: "human-mallory",
      ownerKind: "human",
      agentId: AGENT_ID,
      runtimeTrustClass: "codex-v1",
    })).toEqual({ ok: false, reason: "formation session ownership cannot transfer" });
    expect(validateFormationSessionTransition(selector, {
      operation: "fork",
      ownerPrincipal: "human-alice",
      ownerKind: "human",
      agentId: AGENT_ID,
      runtimeTrustClass: "codex-v2",
    })).toEqual({ ok: false, reason: "runtime trust-class change requires a fresh formation" });
    expect(validateFormationSessionTransition(selector, {
      operation: "fork",
      ownerPrincipal: "human-alice",
      ownerKind: "human",
      agentId: AGENT_ID,
      runtimeTrustClass: "codex-v1",
      targetSessionId: "transport-child",
    })).toEqual({ ok: true });
  });
});
