import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { EvolutionStore, evolutionActiveSnapshotDigest, type EvolutionActiveSnapshotBytes } from "../../src/evolution/EvolutionStore.js";
import { renderEvolutionLearnings } from "../../src/evolution/domain.js";
import { FormationAuthorityStore } from "../../src/agents/formation/authorityStore.js";
import type { AuthorityHead, AuthorityHeadPort } from "../../src/delivery/authorityIntegrity.js";
import {
  EVOLUTION_FORMATION_RENDERER_CONTRACT,
  EVOLUTION_FORMATION_RENDERER_SHA256,
  canonicalEvolutionProfileBytes,
  evolutionActivationHeadForState,
  resolveEvolutionFormationLane,
} from "../../src/agents/formation/evolutionLane.js";
import { EvolutionFormationTransactionService } from "../../src/agents/formation/evolutionTransactions.js";
import { formationDigest, type FormationAuthorityVector, type ProfileActivationHeadV2 } from "../../src/agents/formation/domain.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const NOW = "2026-07-22T12:00:00.000Z";
const WORKSPACE_ID = "workspace-test";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const human = { principal: "human-alice", kind: "human" as const };

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function authorityHarness(): { key: Buffer; port: AuthorityHeadPort } {
  const heads = new Map<string, AuthorityHead>();
  return {
    key: crypto.createHash("sha256").update("formation-evolution-test-authority").digest(),
    port: {
      current: async (identity) => heads.get(identity),
      establishInitial: async (identity, head) => { heads.set(identity, { ...head }); },
      prepare: async (identity, next, expectedMac) => {
        const current = heads.get(identity);
        if (!current || current.mac !== expectedMac || next.revision !== current.revision + 1) throw new Error("head conflict");
        heads.set(identity, { ...next });
      },
      retire: async (identity) => { heads.delete(identity); },
      move: async (fromIdentity, toIdentity, next, expectedMac) => {
        const current = heads.get(fromIdentity);
        if (!current || current.mac !== expectedMac) throw new Error("head conflict");
        heads.delete(fromIdentity);
        heads.set(toIdentity, { ...next });
      },
    },
  };
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-evolution-"));
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-evolution-host-"));
  roots.push(root, host);
  const authority = authorityHarness();
  const evolutionOptions = {
    now: () => NOW,
    uuid: () => crypto.randomUUID(),
    authorityIntegrityKey: () => authority.key,
    authorityHead: authority.port,
  };
  const evolution = new EvolutionStore(root, evolutionOptions);
  await evolution.ensureProfile("codex");
  const skill = await evolution.createCandidate("codex", {
    reviewId: "review-bootstrap",
    taskId: "task-bootstrap",
    target: {
      kind: "skill",
      operation: "create",
      name: "repo-check",
      reason: "approved procedure",
      files: [
        { path: "SKILL.md", content: "---\nname: repo-check\ndescription: Check this repository safely.\n---\n\n# Repo check\n" },
        { path: "scripts/check.sh", content: "#!/bin/sh\nexit 0\n", executable: true },
      ],
    },
  });
  await evolution.approveCandidate("codex", skill.id, { expectedActiveVersion: 0 });
  const active = await evolution.readAuthorizedActiveState("codex");
  const profileDir = path.join(root, ".tachyon", "agents", "codex");
  const manifestSha256 = sha256(canonicalEvolutionProfileBytes(active.profile));
  const agentProfileText = stringify({
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    prompt: { evolution: "evolution" },
    references: [{
      id: "evolution",
      kind: "evolution",
      scope: "profile",
      owner: AGENT_ID,
      path: "evolution/profile.json",
      mode: "pinned",
      sha256: manifestSha256,
    }],
  });
  fs.writeFileSync(path.join(profileDir, "agent.yml"), agentProfileText, { mode: 0o600 });
  const evolutionHead = evolutionActivationHeadForState({
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    revision: 1,
    priorRevision: 0,
    active,
  });
  const profile: ProfileActivationHeadV2 = {
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentName: "codex",
    revision: 1,
    priorRevision: 0,
    canonicalSha256: sha256(agentProfileText),
    effectiveSha256: "a".repeat(64),
    runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: "b".repeat(64) },
    lanes: {
      soul: { mode: "disabled" },
      instructions: { mode: "disabled" },
      evolution: {
        mode: "profile",
        required: true,
        selectorId: "evolution",
        subjectId: active.profile.profileId,
        path: "evolution/profile.json",
        sourceSha256: manifestSha256,
        rendererContract: EVOLUTION_FORMATION_RENDERER_CONTRACT,
        rendererSha256: EVOLUTION_FORMATION_RENDERER_SHA256,
      },
      memory: { mode: "disabled" },
    },
  };
  const vector: FormationAuthorityVector = {
    profile,
    evolution: evolutionHead,
    generation: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      generation: 1,
      priorGeneration: 0,
      retired: false,
      profile: { revision: 1, digest: formationDigest(profile) },
      evolution: { revision: 1, digest: formationDigest(evolutionHead) },
      rendererContractsSha256: "c".repeat(64),
    },
  };
  const captured = await resolveEvolutionFormationLane({
    workspaceRoot: root,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentName: "codex",
    vector,
    store: evolution,
  });
  const formation = new FormationAuthorityStore(host, {
    now: () => NOW,
    authorizeLaunch: () => true,
    authorizeMutation: () => true,
    authorizeSelectorRevocation: () => true,
    authorizeSelectorRead: () => true,
    resolvePayload: () => captured,
  });
  formation.replaceVector({ operationId: "evolution-bootstrap", caller: human, mutation: "bootstrap", vector });
  return { root, evolution, evolutionOptions, formation, vector, active };
}

describe("Evolution formation lane", () => {
  it("snapshots only the exact active learning and complete approved skill inventory", async () => {
    const value = await fixture();
    const resolved = await resolveEvolutionFormationLane({
      workspaceRoot: value.root,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "codex",
      vector: value.vector,
      store: value.evolution,
    });
    expect(String(resolved.startupPrompt)).toContain("repo-check");
    expect(resolved.evolutionSkills?.map((file) => file.path)).toEqual([
      "evolution/repo-check/SKILL.md",
      "evolution/repo-check/scripts/check.sh",
    ]);

    const manifest = value.formation.prepareSnapshot({
      operationId: "evolution-fresh",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "codex",
      runtimeTrustClass: "codex-v1",
      expectedGenerationSha256: formationDigest(value.vector.generation),
    });
    const selector = value.formation.commitFresh({ operationId: "evolution-fresh", caller: human });
    fs.writeFileSync(value.evolution.learningsPath("codex"), "tampered after snapshot", { mode: 0o600 });
    const payload = value.formation.snapshotPayload(selector.sessionId, human);
    expect(payload.manifest.snapshotId).toBe(manifest.snapshotId);
    expect(payload.manifest.objects.filter((object) => object.kind === "evolution-skill")).toHaveLength(2);
    const learningsObject = payload.manifest.objects.find((object) => object.kind === "evolution-learnings");
    expect(learningsObject).toBeDefined();
    expect(payload.objects.get(learningsObject!.sha256)?.toString("utf8")).toBe(resolved.active.learnings);
    expect([...payload.objects.values()].some((bytes) => bytes.toString().includes("Check this repository safely"))).toBe(true);
  });

  it("couples human approval to the Evolution head and formation generation with crash recovery", async () => {
    const value = await fixture();
    const candidate = await value.evolution.createCandidate("codex", {
      reviewId: "review-learning",
      taskId: "task-learning",
      target: { kind: "learning", content: "Keep formation evidence exact.", reason: "reusable invariant" },
    });
    const prior = await value.evolution.readAuthorizedActiveState("codex");
    const priorLearnings = await value.evolution.readLearnings("codex");
    const next: EvolutionActiveSnapshotBytes = {
      profile: { ...prior.profile, activeVersion: prior.profile.activeVersion + 1, updatedAt: NOW },
      learnings: renderEvolutionLearnings([...priorLearnings, {
        id: `learning-${candidate.id.slice("candidate-".length)}`,
        content: "Keep formation evidence exact.",
        sourceTaskId: candidate.taskId,
        sourceReviewId: candidate.reviewId,
        approvedAt: NOW,
      }]),
      skills: structuredClone(prior.skills),
    };
    const nextHead = evolutionActivationHeadForState({
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      revision: 2,
      priorRevision: 1,
      active: next,
    });
    const nextVector = structuredClone(value.vector);
    nextVector.evolution = nextHead;
    nextVector.generation.generation = 2;
    nextVector.generation.priorGeneration = 1;
    nextVector.generation.evolution = { revision: 2, digest: formationDigest(nextHead) };
    const service = new EvolutionFormationTransactionService(value.formation, value.evolution);
    await service.preparePromotion({
      operationId: "evolution-promotion",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "codex",
      candidateId: candidate.id,
      expectedGenerationSha256: formationDigest(value.vector.generation),
      candidate: {
        expectedActiveVersion: prior.profile.activeVersion,
        expectedTargetDigest: sha256(prior.learnings),
      },
    });
    expect(() => value.formation.prepareSnapshot({
      operationId: "fresh-during-evolution",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "codex",
      runtimeTrustClass: "codex-v1",
      expectedGenerationSha256: formationDigest(value.vector.generation),
    })).toThrow("blocked by a prepared authority mutation");
    await expect(service.commit({
      operationId: "evolution-promotion",
      caller: human,
      agentId: AGENT_ID,
      afterSourcePublished: () => { throw new Error("fault after Evolution source publication"); },
    })).rejects.toThrow("fault after Evolution source publication");
    const restartedService = new EvolutionFormationTransactionService(
      value.formation,
      new EvolutionStore(value.root, value.evolutionOptions),
    );
    await expect(restartedService.recover({ agentId: AGENT_ID, caller: human }))
      .resolves.toBe("completed");
    expect(value.formation.currentVector(AGENT_ID)).toEqual(nextVector);
    expect(value.formation.mutationReceipt("evolution-promotion", human)).toMatchObject({
      mutation: "evolution-promotion",
      outcome: "committed",
    });
  });

  it("rejects a caller-forged promotion inventory even when its public digest is recomputed", async () => {
    const value = await fixture();
    const candidate = await value.evolution.createCandidate("codex", {
      reviewId: "review-forgery",
      taskId: "task-forgery",
      target: { kind: "learning", content: "Approved content.", reason: "authorized learning" },
    });
    const prior = await value.evolution.readAuthorizedActiveState("codex");
    const token = await value.evolution.prepareFormationPromotion("codex", candidate.id, {
      expectedActiveVersion: prior.profile.activeVersion,
      expectedTargetDigest: sha256(prior.learnings),
    });
    const forged = structuredClone(token);
    forged.nextActive.learnings = "caller-selected content\n";
    forged.nextActiveSha256 = evolutionActiveSnapshotDigest(forged.nextActive);
    expect(value.evolution.verifyFormationPromotionToken(forged)).toBe(false);
    await expect(value.evolution.approvePreparedFormationPromotion(forged)).rejects.toThrow("token is invalid");
    expect((await value.evolution.readAuthorizedActiveState("codex")).profile.activeVersion).toBe(prior.profile.activeVersion);
  });
});
