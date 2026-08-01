import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { FormationAuthorityStore } from "../../src/agents/formation/authorityStore.js";
import { formationDigest, type FormationAuthorityVector, type ProfileActivationHeadV2 } from "../../src/agents/formation/domain.js";
import {
  EVOLUTION_FORMATION_RENDERER_CONTRACT,
  EVOLUTION_FORMATION_RENDERER_SHA256,
  canonicalEvolutionProfileBytes,
  evolutionActivationHeadForState,
} from "../../src/agents/formation/evolutionLane.js";
import {
  HUMAN_INSTRUCTIONS_RENDERER_CONTRACT,
  HUMAN_INSTRUCTIONS_RENDERER_SHA256,
  HUMAN_SOUL_RENDERER_CONTRACT,
  HUMAN_SOUL_RENDERER_SHA256,
  HumanLaneSuppressionAuthority,
} from "../../src/agents/formation/humanLanes.js";
import {
  SELECTED_MEMORY_RENDERER_CONTRACT,
  SELECTED_MEMORY_RENDERER_SHA256,
  memoryActivationHeadForState,
} from "../../src/agents/formation/memoryLane.js";
import { SelectedMemoryFormationTransactionService } from "../../src/agents/formation/memoryTransactions.js";
import { completeFormationRendererContractsSha256, resolveCompleteFormationPayload } from "../../src/agents/formation/resolver.js";
import { validateFormationSessionTransition } from "../../src/agents/formation/sessionPolicy.js";
import { formationLifecycleConsumerContract } from "../../src/agents/formation/lifecycleContract.js";
import { EvolutionStore } from "../../src/evolution/EvolutionStore.js";
import type { AuthorityHead, AuthorityHeadPort } from "../../src/evolution/authorityIntegrity.js";
import { SelectedMemoryStore } from "../../src/memory/SelectedMemoryStore.js";
import { selectedMemoryCandidateBytes, selectedMemoryManifestBytes, selectedMemorySha256 } from "../../src/memory/domain.js";
import { detectRuntimes, loadPlugin, previewInstall } from "../../src/plugins/engine.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const NOW = "2026-07-22T21:00:00.000Z";
const WORKSPACE_ID = "workspace-dogfood";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SOUL_ID = "22222222-2222-4222-8222-222222222222";
const MEMORY_ID = "selected-memory";
const human = { principal: "human-alice", kind: "human" as const };

function sha256(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function authorityHarness(): { key: Buffer; port: AuthorityHeadPort } {
  const heads = new Map<string, AuthorityHead>();
  return {
    key: crypto.createHash("sha256").update("formation-dogfood-evolution-key").digest(),
    port: {
      current: async (identity) => heads.get(identity),
      establishInitial: async (identity, head) => { heads.set(identity, { ...head }); },
      prepare: async (identity, next, expectedMac) => {
        const current = heads.get(identity);
        if (!current || current.mac !== expectedMac) throw new Error("head conflict");
        heads.set(identity, { ...next });
      },
      retire: async (identity) => { heads.delete(identity); },
      move: async (fromIdentity, toIdentity, next, expectedMac) => {
        const current = heads.get(fromIdentity);
        if (!current || current.mac !== expectedMac) throw new Error("head conflict");
        heads.delete(fromIdentity); heads.set(toIdentity, { ...next });
      },
    },
  };
}

describe("complete agent formation dogfood", () => {
  it("keeps one complete snapshot across promotion, next session, resume, re-anchor and fork without touching plugins", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-dogfood-"));
    const host = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-dogfood-host-"));
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-formation-plugin-"));
    roots.push(root, host, pluginRoot);
    const agentRoot = path.join(root, ".tachyon", "agents", "codex");
    fs.mkdirSync(agentRoot, { recursive: true, mode: 0o700 });

    const evolutionAuthority = authorityHarness();
    const evolution = new EvolutionStore(root, {
      now: () => NOW,
      authorityIntegrityKey: () => evolutionAuthority.key,
      authorityHead: evolutionAuthority.port,
    });
    await evolution.ensureProfile("codex");
    const evolutionCandidate = await evolution.createCandidate("codex", {
      reviewId: "review-dogfood",
      taskId: "task-dogfood",
      target: {
        kind: "skill", operation: "create", name: "formation-proof", reason: "approved invariant",
        files: [{ path: "SKILL.md", content: "---\nname: formation-proof\ndescription: Preserve exact formation bytes.\n---\n\n# Formation proof\n" }],
      },
    });
    await evolution.approveCandidate("codex", evolutionCandidate.id, { expectedActiveVersion: 0 });
    const evolutionActive = await evolution.readAuthorizedActiveState("codex");

    const memoryKey = crypto.createHash("sha256").update("formation-dogfood-memory-key").digest();
    const memory = new SelectedMemoryStore(root, { now: () => NOW, authorityIntegrityKey: () => memoryKey });
    const memoryManifest = await memory.initialize("codex", AGENT_ID, MEMORY_ID);

    const soul = "# Soul\n\nCalm and exact.\n";
    const instructions = "Prefer small, reviewable changes.\n";
    fs.writeFileSync(path.join(agentRoot, "SOUL.md"), soul, { mode: 0o600 });
    fs.writeFileSync(path.join(agentRoot, "instructions.md"), instructions, { mode: 0o600 });
    fs.writeFileSync(path.join(agentRoot, "profile.json"), `${JSON.stringify({
      schemaVersion: 2, profileId: SOUL_ID, owner: "codex", state: "active", agentId: AGENT_ID,
    }, null, 2)}\n`, { mode: 0o600 });

    const evolutionManifestSha256 = sha256(canonicalEvolutionProfileBytes(evolutionActive.profile));
    const memoryManifestSha256 = selectedMemorySha256(selectedMemoryManifestBytes(memoryManifest));
    const profileText = stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
      prompt: { soul: "soul", instructions: "instructions", evolution: "evolution", memory: { policy: "human-approved", reference: MEMORY_ID } },
      references: [
        { id: "soul", kind: "soul", scope: "profile", owner: AGENT_ID, path: "SOUL.md", mode: "pinned", sha256: sha256(soul) },
        { id: "instructions", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "instructions.md", mode: "pinned", sha256: sha256(instructions) },
        { id: "evolution", kind: "evolution", scope: "profile", owner: AGENT_ID, path: "evolution/profile.json", mode: "pinned", sha256: evolutionManifestSha256 },
        { id: MEMORY_ID, kind: "memory", scope: "profile", owner: AGENT_ID, path: "memory/manifest.json", mode: "pinned", sha256: memoryManifestSha256 },
      ],
    });
    fs.writeFileSync(path.join(agentRoot, "agent.yml"), profileText, { mode: 0o600 });

    const evolutionHead = evolutionActivationHeadForState({
      workspaceId: WORKSPACE_ID, agentId: AGENT_ID, revision: 1, priorRevision: 0, active: evolutionActive,
    });
    const memoryHead = memoryActivationHeadForState({
      workspaceId: WORKSPACE_ID, agentId: AGENT_ID, profileRevision: 1, revision: 1, priorRevision: 0,
      active: await memory.readActiveState("codex"),
    });
    const profile: ProfileActivationHeadV2 = {
      schemaVersion: 2, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, agentName: "codex",
      revision: 1, priorRevision: 0, canonicalSha256: sha256(profileText), effectiveSha256: "a".repeat(64),
      runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: "b".repeat(64) },
      lanes: {
        soul: { mode: "profile", required: true, selectorId: "soul", subjectId: SOUL_ID, path: "SOUL.md", sourceSha256: sha256(soul), rendererContract: HUMAN_SOUL_RENDERER_CONTRACT, rendererSha256: HUMAN_SOUL_RENDERER_SHA256 },
        instructions: { mode: "profile", required: true, selectorId: "instructions", subjectId: "instructions", path: "instructions.md", sourceSha256: sha256(instructions), rendererContract: HUMAN_INSTRUCTIONS_RENDERER_CONTRACT, rendererSha256: HUMAN_INSTRUCTIONS_RENDERER_SHA256 },
        evolution: { mode: "profile", required: true, selectorId: "evolution", subjectId: evolutionActive.profile.profileId, path: "evolution/profile.json", sourceSha256: evolutionManifestSha256, rendererContract: EVOLUTION_FORMATION_RENDERER_CONTRACT, rendererSha256: EVOLUTION_FORMATION_RENDERER_SHA256 },
        memory: { mode: "profile", required: true, selectorId: MEMORY_ID, subjectId: MEMORY_ID, path: "memory/manifest.json", sourceSha256: memoryManifestSha256, rendererContract: SELECTED_MEMORY_RENDERER_CONTRACT, rendererSha256: SELECTED_MEMORY_RENDERER_SHA256 },
      },
    };
    const vector = {
      profile, evolution: evolutionHead, memory: memoryHead,
      generation: {
        schemaVersion: 1 as const, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, generation: 1, priorGeneration: 0,
        retired: false, profile: { revision: 1, digest: formationDigest(profile) },
        evolution: { revision: 1, digest: formationDigest(evolutionHead) },
        memory: { revision: 1, digest: formationDigest(memoryHead) }, rendererContractsSha256: "0".repeat(64),
      },
    } satisfies FormationAuthorityVector;
    vector.generation.rendererContractsSha256 = completeFormationRendererContractsSha256(vector);

    let suppressionNow = NOW;
    const suppression = new HumanLaneSuppressionAuthority(Buffer.alloc(32, 9), () => suppressionNow, 60_000);
    const formation = new FormationAuthorityStore(host, {
      now: () => suppressionNow,
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: ({ caller, ownerPrincipal, ownerKind }) => caller.principal === ownerPrincipal && caller.kind === ownerKind,
      resolvePayload: () => { throw new Error("complete async resolver must be supplied explicitly"); },
      verifyNativeSuppression: ({ evidence, vector: current, operationId, runtimeTrustClass, verifiedAt }) =>
        suppression.verify(evidence, current, runtimeTrustClass, operationId, verifiedAt),
    });
    formation.replaceVector({ operationId: "dogfood-bootstrap", caller: human, mutation: "bootstrap", vector });
    const resolve = async (operationId: string, current: FormationAuthorityVector, taskBrief: string) => {
      const receipt = suppression.issueAfterSuppression({
        operationId, vector: current, runtimeAdapter: "codex", runtimeTrustClass: "codex-v1",
        lanes: ["soul", "instructions", "evolution", "memory"], issuedAt: NOW,
      });
      return resolveCompleteFormationPayload({
        operationId, workspaceRoot: root, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, agentName: "codex",
        vector: current, role: "coder", bridgeGuidance: false, projectGuidance: "Project guidance.", taskBrief,
        runtimeTrustClass: "codex-v1", suppressionAuthority: suppression, suppressionReceipt: receipt,
        evolutionStore: evolution, memoryStore: memory,
      });
    };

    fs.mkdirSync(path.join(root, ".codex"));
    fs.writeFileSync(path.join(pluginRoot, "tachyon-plugin.json"), JSON.stringify({
      name: "formation-sentinel", version: "1.0.0", description: "compatibility sentinel",
      runtimes: ["codex"], blocks: { codex: "codex/" },
    }));
    fs.mkdirSync(path.join(pluginRoot, "codex"));
    fs.writeFileSync(path.join(pluginRoot, "codex", "hooks.json"), JSON.stringify({
      PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: '"${PLUGIN_ROOT}"/gate.sh', statusMessage: "checking" }] }],
    }));
    fs.writeFileSync(path.join(pluginRoot, "codex", "gate.sh"), "#!/bin/sh\nexit 0\n");
    const pluginBefore = loadPlugin(pluginRoot);
    expect(pluginBefore.errors).toEqual([]);
    const pluginPlanBefore = previewInstall(pluginBefore.plugin!, root, detectRuntimes(root));

    const firstPayload = await resolve("fresh-before-promotion", vector, "First task.");
    const firstText = String(firstPayload.startupPrompt);
    const layerPositions = [
      firstText.indexOf("## Identity"),
      firstText.indexOf("Your task: implement the assigned change"),
      firstText.indexOf("Prefer small, reviewable changes."),
      firstText.indexOf("## Agent Evolution"),
      firstText.indexOf("## Selected Memory"),
      firstText.indexOf("First task."),
    ];
    expect(layerPositions.every((position) => position >= 0)).toBe(true);
    expect(layerPositions).toEqual([...layerPositions].sort((left, right) => left - right));
    suppressionNow = "2026-07-22T21:02:00.000Z";
    expect(() => formation.prepareResolvedSnapshot({
      operationId: "fresh-before-promotion", caller: human, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
      agentName: "codex", runtimeTrustClass: "codex-v1", expectedGenerationSha256: formationDigest(vector.generation),
    }, firstPayload)).toThrow("suppression is invalid at publication");
    suppressionNow = NOW;
    const firstManifest = formation.prepareResolvedSnapshot({
      operationId: "fresh-before-promotion", caller: human, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
      agentName: "codex", runtimeTrustClass: "codex-v1", expectedGenerationSha256: formationDigest(vector.generation),
    }, firstPayload);
    suppressionNow = "2026-07-22T21:02:00.000Z";
    expect(() => formation.commitFresh({ operationId: "fresh-before-promotion", caller: human }))
      .toThrow("suppression expired before selector commit");
    suppressionNow = NOW;
    const first = formation.commitFresh({ operationId: "fresh-before-promotion", caller: human });
    expect(firstPayload.startupPrompt).not.toContain("Keep plugins workspace-scoped");

    const candidate = await memory.createCandidate("codex", {
      agentId: AGENT_ID, content: "Keep plugins workspace-scoped until their own architecture task.",
      reason: "ratified product boundary", sourcePrincipal: "codex", sourceKind: "agent",
    });
    const memoryTransactions = new SelectedMemoryFormationTransactionService(formation, memory);
    await memoryTransactions.preparePromotion({
      operationId: "memory-promotion", caller: human, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
      agentName: "codex", candidateId: candidate.id, expectedGenerationSha256: formationDigest(vector.generation),
      expectedMemoryVersion: 0, expectedCandidateSha256: selectedMemorySha256(selectedMemoryCandidateBytes(candidate)),
    });
    const nextVector = await memoryTransactions.commit({ operationId: "memory-promotion", caller: human, agentId: AGENT_ID });
    const secondPayload = await resolve("fresh-after-promotion", nextVector, "Second task.");
    expect(secondPayload.startupPrompt).toContain("Keep plugins workspace-scoped");
    expect(secondPayload.reanchorReminder).not.toContain("Second task.");
    const secondManifest = formation.prepareResolvedSnapshot({
      operationId: "fresh-after-promotion", caller: human, workspaceId: WORKSPACE_ID, agentId: AGENT_ID,
      agentName: "codex", runtimeTrustClass: "codex-v1", expectedGenerationSha256: formationDigest(nextVector.generation),
    }, secondPayload);
    const second = formation.commitFresh({ operationId: "fresh-after-promotion", caller: human });

    fs.writeFileSync(path.join(agentRoot, "SOUL.md"), "tampered soul");
    fs.writeFileSync(path.join(agentRoot, "instructions.md"), "tampered instructions");
    fs.writeFileSync(evolution.learningsPath("codex"), "tampered evolution");
    const firstPinned = formation.snapshotPayload(first.sessionId, human);
    const secondPinned = formation.snapshotPayload(second.sessionId, human);
    const firstPrompt = firstManifest.objects.find((object) => object.kind === "startup-prompt")!;
    const secondPrompt = secondManifest.objects.find((object) => object.kind === "startup-prompt")!;
    expect(firstPinned.objects.get(firstPrompt.sha256)?.toString()).toBe(firstPayload.startupPrompt);
    expect(secondPinned.objects.get(secondPrompt.sha256)?.toString()).toBe(secondPayload.startupPrompt);
    for (const operation of ["restart", "resume", "rebind", "reanchor"] as const) {
      expect(validateFormationSessionTransition(second, {
        operation, ownerPrincipal: human.principal, ownerKind: human.kind, agentId: AGENT_ID,
        runtimeTrustClass: "codex-v1", ...(operation === "rebind" ? { targetSessionId: crypto.randomUUID() } : {}),
      })).toEqual({ ok: true });
    }
    const fork = formation.fork({ operationId: "dogfood-fork", caller: human, parentSessionId: second.sessionId });
    expect(formation.snapshotPayload(fork.sessionId, human).objects.get(secondPrompt.sha256)?.toString()).toBe(secondPayload.startupPrompt);
    const reminder = secondManifest.objects.find((object) => object.kind === "reanchor-reminder")!;
    expect(secondPinned.objects.get(reminder.sha256)?.toString()).toBe(secondPayload.reanchorReminder);

    const pluginAfter = loadPlugin(pluginRoot);
    const pluginPlanAfter = previewInstall(pluginAfter.plugin!, root, detectRuntimes(root));
    expect(pluginAfter.errors).toEqual(pluginBefore.errors);
    expect(pluginAfter.plugin).toEqual(pluginBefore.plugin);
    expect(pluginPlanAfter).toEqual(pluginPlanBefore);
    expect(JSON.stringify(secondManifest)).not.toContain("pluginRoot");
    expect(fs.readFileSync(path.join(pluginRoot, "codex", "gate.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");

    const hooks = (["soul", "instructions", "evolution", "memory"] as const).map((lane) => ({
      lane, inspect: () => lane, recover: () => lane, retire: () => lane,
    }));
    expect(Object.keys(formationLifecycleConsumerContract(hooks).hooks)).toEqual(["soul", "instructions", "evolution", "memory"]);
    expect(() => formationLifecycleConsumerContract(hooks.slice(1))).toThrow("hook 'soul' is missing");
  });
});
