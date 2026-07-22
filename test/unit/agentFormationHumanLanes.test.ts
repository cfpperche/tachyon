import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { FormationAuthorityStore } from "../../src/agents/formation/authorityStore.js";
import { HumanLaneTransactionService } from "../../src/agents/formation/humanLaneTransactions.js";
import {
  HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
  HUMAN_INSTRUCTIONS_RENDERER_CONTRACT,
  HUMAN_INSTRUCTIONS_RENDERER_SHA256,
  HUMAN_SOUL_RENDERER_CONTRACT,
  HUMAN_SOUL_RENDERER_SHA256,
  HumanLaneSuppressionAuthority,
  resolveHumanFormationPayload,
} from "../../src/agents/formation/humanLanes.js";
import { formationDigest, type FormationAuthorityVector, type ProfileActivationHeadV2 } from "../../src/agents/formation/domain.js";
import { resolvePersistentInstructions } from "../../src/agents/persistentInstructions.js";
import {
  resolveSoul,
} from "../../src/agents/soul.js";
import {
  closeCanonicalAgentProfile,
  readCanonicalAgentProfile,
  replaceCanonicalAgentProfileEntry,
} from "../../src/config/agentProfileReader.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const human = { principal: "human-alice", kind: "human" as const };
const suppressionAuthority = new HumanLaneSuppressionAuthority(Buffer.alloc(32, 7), () => "2026-07-22T12:01:00.000Z");

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function workspace(): { root: string; profileDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-human-lanes-"));
  roots.push(root);
  const profileDir = path.join(root, ".tachyon", "agents", "codex");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, ".tachyon"), 0o700);
  fs.chmodSync(path.join(root, ".tachyon", "agents"), 0o700);
  fs.chmodSync(profileDir, 0o700);
  return { root, profileDir };
}

async function activatedHumanWorkspace() {
  const value = workspace();
  const soulBody = "# Soul\n\nSteady, precise, and candid.\n";
  fs.writeFileSync(path.join(value.profileDir, "SOUL.md"), soulBody, { mode: 0o600 });
  fs.writeFileSync(path.join(value.profileDir, "profile.json"), `${JSON.stringify({
    schemaVersion: 2,
    profileId: PROFILE_ID,
    owner: "codex",
    state: "active",
    agentId: AGENT_ID,
  }, null, 2)}\n`, { mode: 0o600 });
  const instructionBody = "Prefer small, reviewable commits.\n";
  const instructionSha256 = sha256(instructionBody);
  const profile = {
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    prompt: { soul: "soul", instructions: "instructions" },
    references: [
      { id: "soul", kind: "soul", scope: "profile", owner: AGENT_ID, path: "SOUL.md", mode: "pinned", sha256: sha256(soulBody) },
      { id: "instructions", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "instructions.md", mode: "pinned", sha256: instructionSha256 },
    ],
  } as const;
  const profileText = stringify(profile);
  fs.writeFileSync(path.join(value.profileDir, "agent.yml"), profileText, { mode: 0o600 });
  fs.writeFileSync(path.join(value.profileDir, "instructions.md"), instructionBody, { mode: 0o600 });
  const profileSha256 = sha256(profileText);
  return { ...value, soulBody, instructionBody, instructionSha256, profileSha256 };
}

function vector(soulSha256: string, instructionsSha256: string, profileSha256: string): FormationAuthorityVector {
  const profile: ProfileActivationHeadV2 = {
    schemaVersion: 2,
    workspaceId: "workspace-test",
    agentId: AGENT_ID,
    agentName: "codex",
    revision: 1,
    priorRevision: 0,
    canonicalSha256: profileSha256,
    effectiveSha256: "b".repeat(64),
    runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: "c".repeat(64) },
    lanes: {
      soul: {
        mode: "profile",
        required: true,
        selectorId: "soul",
        subjectId: PROFILE_ID,
        path: "SOUL.md",
        sourceSha256: soulSha256,
        rendererContract: HUMAN_SOUL_RENDERER_CONTRACT,
        rendererSha256: HUMAN_SOUL_RENDERER_SHA256,
      },
      instructions: {
        mode: "profile",
        required: true,
        selectorId: "instructions",
        subjectId: "instructions",
        path: "instructions.md",
        sourceSha256: instructionsSha256,
        rendererContract: HUMAN_INSTRUCTIONS_RENDERER_CONTRACT,
        rendererSha256: HUMAN_INSTRUCTIONS_RENDERER_SHA256,
      },
      evolution: { mode: "disabled" },
      memory: { mode: "disabled" },
    },
  };
  return {
    profile,
    generation: {
      schemaVersion: 1,
      workspaceId: "workspace-test",
      agentId: AGENT_ID,
      generation: 1,
      priorGeneration: 0,
      retired: false,
      profile: { revision: 1, digest: formationDigest(profile) },
      rendererContractsSha256: HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
    },
  };
}

describe("human formation lanes", () => {
  it("rejects an unbound legacy Soul manifest until the coordinated migration binds agentId", async () => {
    const value = workspace();
    fs.writeFileSync(path.join(value.profileDir, "SOUL.md"), "Identity", { mode: 0o600 });
    fs.writeFileSync(path.join(value.profileDir, "profile.json"), JSON.stringify({ schemaVersion: 1, profileId: PROFILE_ID, owner: "codex", state: "active" }), { mode: 0o600 });
    await expect(resolveSoul(value.root, "codex", AGENT_ID)).rejects.toThrow("not bound to agentId");
  });

  it("writes and reads only the pinned conventional instructions source", async () => {
    const value = await activatedHumanWorkspace();
    expect(resolvePersistentInstructions({
      workspaceRoot: value.root,
      agentName: "codex",
      agentId: AGENT_ID,
      referenceId: "instructions",
      subjectId: "instructions",
      expectedPath: "instructions.md",
      expectedProfileSha256: value.profileSha256,
      expectedSha256: value.instructionSha256,
    })).toMatchObject({ body: value.instructionBody, sha256: value.instructionSha256, referenceId: "instructions" });
    fs.unlinkSync(path.join(value.profileDir, "instructions.md"));
    fs.symlinkSync(path.join(value.root, "outside"), path.join(value.profileDir, "instructions.md"));
    expect(() => resolvePersistentInstructions({
      workspaceRoot: value.root,
      agentName: "codex",
      agentId: AGENT_ID,
      referenceId: "instructions",
      subjectId: "instructions",
      expectedPath: "instructions.md",
      expectedProfileSha256: value.profileSha256,
      expectedSha256: value.instructionSha256,
    })).toThrow();
  });

  it("pins exact startup and re-anchor bytes across source mutation and forks", async () => {
    const value = await activatedHumanWorkspace();
    const active = vector(sha256(value.soulBody), value.instructionSha256, value.profileSha256);
    const suppressionReceipt = suppressionAuthority.issueAfterSuppression({
      operationId: "human-fresh",
      vector: active,
      runtimeAdapter: "codex",
      runtimeTrustClass: "codex-v1",
      lanes: ["soul", "instructions"],
      issuedAt: "2026-07-22T12:00:00.000Z",
    });
    const payload = await resolveHumanFormationPayload({
      operationId: "human-fresh",
      workspaceRoot: value.root,
      vector: active,
      role: "coder",
      bridgeGuidance: false,
      projectGuidance: "Project-owned guidance.",
      taskBrief: "One-run task text.",
      runtimeTrustClass: "codex-v1",
      suppressionAuthority,
      suppressionReceipt,
    });
    expect(String(payload.startupPrompt)).toContain(value.soulBody.trim());
    expect(String(payload.startupPrompt)).toContain(value.instructionBody.trim());
    expect(String(payload.startupPrompt)).toContain("One-run task text.");
    expect(String(payload.reanchorReminder)).not.toContain("One-run task text.");

    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-human-lanes-host-"));
    roots.push(hostRoot);
    const store = new FormationAuthorityStore(hostRoot, {
      now: () => "2026-07-22T12:01:00.000Z",
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: ({ caller, ownerPrincipal, ownerKind }) => caller.principal === ownerPrincipal && caller.kind === ownerKind,
      resolvePayload: () => payload,
      verifyNativeSuppression: ({ evidence, vector: current, operationId, runtimeTrustClass, verifiedAt }) =>
        suppressionAuthority.verify(evidence, current, runtimeTrustClass, operationId, verifiedAt),
    });
    store.replaceVector({ operationId: "human-bootstrap", caller: human, mutation: "bootstrap", vector: active });
    const manifest = store.prepareSnapshot({
      operationId: "human-fresh",
      caller: human,
      workspaceId: "workspace-test",
      agentId: AGENT_ID,
      agentName: "codex",
      runtimeTrustClass: "codex-v1",
      expectedGenerationSha256: formationDigest(active.generation),
    });
    const selector = store.commitFresh({ operationId: "human-fresh", caller: human });
    fs.writeFileSync(path.join(value.profileDir, "SOUL.md"), "mutated source", { mode: 0o600 });
    fs.writeFileSync(path.join(value.profileDir, "instructions.md"), "mutated instructions", { mode: 0o600 });
    const selected = store.snapshotPayload(selector.sessionId, human);
    const startup = selected.manifest.objects.find((object) => object.kind === "startup-prompt")!;
    const reminder = selected.manifest.objects.find((object) => object.kind === "reanchor-reminder")!;
    expect(selected.objects.get(startup.sha256)?.toString()).toBe(payload.startupPrompt);
    expect(selected.objects.get(reminder.sha256)?.toString()).toBe(payload.reanchorReminder);
    const fork = store.fork({ operationId: "human-fork", caller: human, parentSessionId: selector.sessionId });
    expect(fork.snapshotId).toBe(manifest.snapshotId);
    expect(store.snapshotPayload(fork.sessionId, human).objects.get(startup.sha256)?.toString()).toBe(payload.startupPrompt);
  });

  it("fails the whole formation on required-lane or suppression mismatch", async () => {
    const value = await activatedHumanWorkspace();
    const active = vector(sha256(value.soulBody), value.instructionSha256, value.profileSha256);
    expect(() => suppressionAuthority.issueAfterSuppression({
      operationId: "human-invalid-suppression",
      vector: active,
      runtimeAdapter: "codex",
      runtimeTrustClass: "codex-v1",
      lanes: ["soul"],
      issuedAt: "2026-07-22T12:00:00.000Z",
    })).toThrow("every enabled human lane exactly once");
    const receipt = suppressionAuthority.issueAfterSuppression({
      operationId: "human-required-lane",
      vector: active,
      runtimeAdapter: "codex",
      runtimeTrustClass: "codex-v1",
      lanes: ["soul", "instructions"],
      issuedAt: "2026-07-22T12:00:00.000Z",
    });
    await expect(resolveHumanFormationPayload({
      operationId: "another-fresh-operation",
      workspaceRoot: value.root,
      vector: active,
      bridgeGuidance: false,
      runtimeTrustClass: "codex-v1",
      suppressionAuthority,
      suppressionReceipt: receipt,
    })).rejects.toThrow("suppression receipt is invalid");
    fs.unlinkSync(path.join(value.profileDir, "SOUL.md"));
    await expect(resolveHumanFormationPayload({
      operationId: "human-required-lane",
      workspaceRoot: value.root,
      vector: active,
      bridgeGuidance: false,
      runtimeTrustClass: "codex-v1",
      suppressionAuthority,
      suppressionReceipt: receipt,
    })).rejects.toThrow();
  });

  it("commits and recovers human lane source plus authority as one blocked transaction", async () => {
    const value = workspace();
    const soulBody = "# Soul\n\nBound identity.\n";
    fs.writeFileSync(path.join(value.profileDir, "SOUL.md"), soulBody, { mode: 0o600 });
    fs.writeFileSync(path.join(value.profileDir, "profile.json"), `${JSON.stringify({
      schemaVersion: 1, profileId: PROFILE_ID, owner: "codex", state: "active",
    }, null, 2)}\n`, { mode: 0o600 });
    const priorProfileText = stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
    });
    fs.writeFileSync(path.join(value.profileDir, "agent.yml"), priorProfileText, { mode: 0o600 });
    const priorProfile: ProfileActivationHeadV2 = {
      schemaVersion: 2,
      workspaceId: "workspace-test",
      agentId: AGENT_ID,
      agentName: "codex",
      revision: 1,
      priorRevision: 0,
      canonicalSha256: sha256(priorProfileText),
      effectiveSha256: "a".repeat(64),
      runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: "c".repeat(64) },
      lanes: { soul: { mode: "disabled" }, instructions: { mode: "disabled" }, evolution: { mode: "disabled" }, memory: { mode: "disabled" } },
    };
    const prior: FormationAuthorityVector = {
      profile: priorProfile,
      generation: {
        schemaVersion: 1,
        workspaceId: "workspace-test",
        agentId: AGENT_ID,
        generation: 1,
        priorGeneration: 0,
        retired: false,
        profile: { revision: 1, digest: formationDigest(priorProfile) },
        rendererContractsSha256: HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
      },
    };
    const instructions = "Operate from evidence.\n";
    const nextProfileText = stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
      prompt: { soul: "soul", instructions: "instructions" },
      references: [
        { id: "soul", kind: "soul", scope: "profile", owner: AGENT_ID, path: "SOUL.md", mode: "pinned", sha256: sha256(soulBody) },
        { id: "instructions", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "instructions.md", mode: "pinned", sha256: sha256(instructions) },
      ],
    });
    const next = vector(sha256(soulBody), sha256(instructions), sha256(nextProfileText));
    next.profile.revision = 2;
    next.profile.priorRevision = 1;
    next.generation.generation = 2;
    next.generation.priorGeneration = 1;
    next.generation.profile = { revision: 2, digest: formationDigest(next.profile) };

    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-human-transaction-host-"));
    roots.push(hostRoot);
    const store = new FormationAuthorityStore(hostRoot, {
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: () => true,
      resolvePayload: ({ vector: active }) => ({
        sourceVectorSha256: formationDigest(active),
        rendererContractsSha256: active.generation.rendererContractsSha256,
        startupPrompt: "unused",
        reanchorReminder: "unused",
      }),
    });
    store.replaceVector({ operationId: "human-tx-bootstrap", caller: human, mutation: "bootstrap", vector: prior });
    const service = new HumanLaneTransactionService(store);
    const mismatchedSoulSha256 = sha256("different Soul bytes");
    const mismatchedProfileText = nextProfileText.replace(sha256(soulBody), mismatchedSoulSha256);
    const mismatched = structuredClone(next);
    mismatched.profile.canonicalSha256 = sha256(mismatchedProfileText);
    if (mismatched.profile.lanes.soul.mode === "profile") mismatched.profile.lanes.soul.sourceSha256 = mismatchedSoulSha256;
    mismatched.generation.profile = { revision: 2, digest: formationDigest(mismatched.profile) };
    expect(() => service.prepareProfileEdit({
      operationId: "human-tx-bad-soul",
      caller: human,
      workspaceId: "workspace-test",
      workspaceRoot: value.root,
      agentId: AGENT_ID,
      agentName: "codex",
      expectedGenerationSha256: formationDigest(prior.generation),
      nextVector: mismatched,
      nextAgentProfile: mismatchedProfileText,
      nextInstructions: instructions,
    })).toThrow("next Soul reference");
    service.prepareProfileEdit({
      operationId: "human-tx-commit",
      caller: human,
      workspaceId: "workspace-test",
      workspaceRoot: value.root,
      agentId: AGENT_ID,
      agentName: "codex",
      expectedGenerationSha256: formationDigest(prior.generation),
      nextVector: next,
      nextAgentProfile: nextProfileText,
      nextInstructions: instructions,
    });
    expect(() => store.prepareSnapshot({
      operationId: "blocked-during-human-tx",
      caller: human,
      workspaceId: "workspace-test",
      agentId: AGENT_ID,
      agentName: "codex",
      runtimeTrustClass: "codex-v1",
      expectedGenerationSha256: formationDigest(prior.generation),
    })).toThrow("blocked by a prepared authority mutation");
    expect(service.commit(AGENT_ID, "human-tx-commit", human)).toEqual(next);
    expect(store.currentVector(AGENT_ID)).toEqual(next);
    expect(service.status("human-tx-commit", human)).toMatchObject({ outcome: "committed", agentId: AGENT_ID });
    await expect(resolveSoul(value.root, "codex", AGENT_ID)).resolves.toMatchObject({ profileId: PROFILE_ID, agentId: AGENT_ID });
    expect(resolvePersistentInstructions({
      workspaceRoot: value.root,
      agentName: "codex",
      agentId: AGENT_ID,
      referenceId: "instructions",
      subjectId: "instructions",
      expectedPath: "instructions.md",
      expectedProfileSha256: sha256(nextProfileText),
      expectedSha256: sha256(instructions),
    }).body).toBe(instructions);

    const thirdInstructions = "Operate from verified evidence.\n";
    const thirdProfileText = nextProfileText.replace(sha256(instructions), sha256(thirdInstructions));
    const third = structuredClone(next);
    third.profile.revision = 3;
    third.profile.priorRevision = 2;
    third.profile.canonicalSha256 = sha256(thirdProfileText);
    if (third.profile.lanes.instructions.mode === "profile") {
      third.profile.lanes.instructions.sourceSha256 = sha256(thirdInstructions);
    }
    third.generation.generation = 3;
    third.generation.priorGeneration = 2;
    third.generation.profile = { revision: 3, digest: formationDigest(third.profile) };
    service.prepareProfileEdit({
      operationId: "human-tx-recover",
      caller: human,
      workspaceId: "workspace-test",
      workspaceRoot: value.root,
      agentId: AGENT_ID,
      agentName: "codex",
      expectedGenerationSha256: formationDigest(next.generation),
      nextVector: third,
      nextAgentProfile: thirdProfileText,
      nextInstructions: thirdInstructions,
    });
    const source = readCanonicalAgentProfile(value.root, "codex")!;
    try {
      replaceCanonicalAgentProfileEntry({
        source,
        name: "agent.yml",
        expectedSha256: sha256(nextProfileText),
        bytes: Buffer.from(thirdProfileText),
      });
    } finally { closeCanonicalAgentProfile(source); }
    expect(service.recover(AGENT_ID, human)).toBe("rolled-back");
    const restored = readCanonicalAgentProfile(value.root, "codex")!;
    try { expect(restored.sha256).toBe(sha256(nextProfileText)); }
    finally { closeCanonicalAgentProfile(restored); }

    service.prepareProfileEdit({
      operationId: "human-tx-authority-crash",
      caller: human,
      workspaceId: "workspace-test",
      workspaceRoot: value.root,
      agentId: AGENT_ID,
      agentName: "codex",
      expectedGenerationSha256: formationDigest(next.generation),
      nextVector: third,
      nextAgentProfile: thirdProfileText,
      nextInstructions: thirdInstructions,
    });
    expect(() => service.commit(AGENT_ID, "human-tx-authority-crash", human, {
      afterAuthorityCommitted: () => { throw new Error("fault after authority"); },
    })).toThrow("fault after authority");
    expect(service.recover(AGENT_ID, human)).toBe("completed");
    expect(service.status("human-tx-authority-crash", human)).toMatchObject({ outcome: "committed", mutation: "profile-edit" });
  });

  it("cuts legacy Soul/instructions over once and rolls back pre-authority crashes", async () => {
    const value = workspace();
    const soulBody = "# Soul\n\nLegacy identity.\n";
    const instructions = "Legacy persistent instruction.\n";
    fs.writeFileSync(path.join(value.profileDir, "SOUL.md"), soulBody, { mode: 0o600 });
    fs.writeFileSync(path.join(value.profileDir, "profile.json"), `${JSON.stringify({
      schemaVersion: 1, profileId: PROFILE_ID, owner: "codex", state: "active",
    }, null, 2)}\n`, { mode: 0o600 });
    const configPath = path.join(value.root, "tachyon.yml");
    const priorConfig = stringify({ agents: { codex: { cmd: "codex", soul: true, instructions } } });
    const nextConfig = stringify({ agents: { codex: { profile: ".tachyon/agents/codex/agent.yml" } } });
    fs.writeFileSync(configPath, priorConfig, { mode: 0o600 });
    const legacyProfile: ProfileActivationHeadV2 = {
      schemaVersion: 2,
      workspaceId: "workspace-test",
      agentId: AGENT_ID,
      agentName: "codex",
      revision: 1,
      priorRevision: 0,
      canonicalSha256: sha256(priorConfig),
      effectiveSha256: "a".repeat(64),
      runtimeInspector: { adapter: "codex", id: "inspector", version: "1", sha256: "c".repeat(64) },
      lanes: { soul: { mode: "legacy" }, instructions: { mode: "legacy" }, evolution: { mode: "legacy" }, memory: { mode: "legacy" } },
    };
    const legacy: FormationAuthorityVector = {
      profile: legacyProfile,
      generation: {
        schemaVersion: 1,
        workspaceId: "workspace-test",
        agentId: AGENT_ID,
        generation: 1,
        priorGeneration: 0,
        retired: false,
        profile: { revision: 1, digest: formationDigest(legacyProfile) },
        rendererContractsSha256: HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
      },
    };
    const nextProfileText = stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
      prompt: { soul: "soul", instructions: "instructions" },
      references: [
        { id: "soul", kind: "soul", scope: "profile", owner: AGENT_ID, path: "SOUL.md", mode: "pinned", sha256: sha256(soulBody) },
        { id: "instructions", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "instructions.md", mode: "pinned", sha256: sha256(instructions) },
      ],
    });
    const canonical = vector(sha256(soulBody), sha256(instructions), sha256(nextProfileText));
    canonical.profile.revision = 2;
    canonical.profile.priorRevision = 1;
    canonical.generation.generation = 2;
    canonical.generation.priorGeneration = 1;
    canonical.generation.profile = { revision: 2, digest: formationDigest(canonical.profile) };
    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-human-migration-host-"));
    roots.push(hostRoot);
    const store = new FormationAuthorityStore(hostRoot, {
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: () => true,
      resolvePayload: ({ vector: active }) => ({
        sourceVectorSha256: formationDigest(active),
        rendererContractsSha256: active.generation.rendererContractsSha256,
        startupPrompt: "unused",
        reanchorReminder: "unused",
      }),
    });
    store.replaceVector({ operationId: "legacy-bootstrap", caller: human, mutation: "bootstrap", vector: legacy });
    const service = new HumanLaneTransactionService(store);
    const prepare = (operationId: string) => service.prepareLegacyMigration({
      operationId,
      caller: human,
      workspaceId: "workspace-test",
      workspaceRoot: value.root,
      configPath,
      expectedConfigSha256: sha256(priorConfig),
      nextConfigText: nextConfig,
      agentId: AGENT_ID,
      agentName: "codex",
      expectedGenerationSha256: formationDigest(legacy.generation),
      expectedLegacyInstructionsSha256: sha256(instructions),
      legacyInstructions: instructions,
      nextVector: canonical,
      nextAgentProfile: nextProfileText,
    });
    prepare("legacy-cutover-crash");
    expect(() => service.commit(AGENT_ID, "legacy-cutover-crash", human, {
      afterSourcePublished: () => { throw new Error("fault after pointer-written"); },
    })).toThrow("fault after pointer-written");
    expect(service.recover(AGENT_ID, human)).toBe("rolled-back");
    expect(fs.readFileSync(configPath, "utf8")).toBe(priorConfig);
    expect(fs.existsSync(path.join(value.profileDir, "agent.yml"))).toBe(false);
    expect(fs.existsSync(path.join(value.profileDir, "instructions.md"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(value.profileDir, "profile.json"), "utf8"))).not.toHaveProperty("agentId");

    prepare("legacy-cutover-success");
    expect(service.commit(AGENT_ID, "legacy-cutover-success", human)).toEqual(canonical);
    expect(fs.readFileSync(configPath, "utf8")).toBe(nextConfig);
    expect(fs.readFileSync(path.join(value.profileDir, "instructions.md"), "utf8")).toBe(instructions);
    expect(JSON.parse(fs.readFileSync(path.join(value.profileDir, "profile.json"), "utf8"))).toMatchObject({ schemaVersion: 2, agentId: AGENT_ID });
    expect(store.currentVector(AGENT_ID)).toEqual(canonical);

    const retired = structuredClone(canonical);
    retired.generation.generation = 3;
    retired.generation.priorGeneration = 2;
    retired.generation.retired = true;
    service.prepareRetirement({
      operationId: "retire-human-agent",
      caller: human,
      workspaceId: "workspace-test",
      workspaceRoot: value.root,
      agentId: AGENT_ID,
      agentName: "codex",
      expectedGenerationSha256: formationDigest(canonical.generation),
      nextVector: retired,
      nextAgentProfile: nextProfileText,
    });
    expect(service.inspect(AGENT_ID, human).activeMutation).toMatchObject({ mutation: "retire", phase: "prepared" });
    expect(service.commit(AGENT_ID, "retire-human-agent", human)).toEqual(retired);
    expect(service.status("retire-human-agent", human)).toMatchObject({ outcome: "committed", mutation: "retire" });
    const repeatedlyRetired = structuredClone(retired);
    repeatedlyRetired.generation.generation = 4;
    repeatedlyRetired.generation.priorGeneration = 3;
    expect(() => service.prepareRetirement({
      operationId: "retire-human-agent-again",
      caller: human,
      workspaceId: "workspace-test",
      workspaceRoot: value.root,
      agentId: AGENT_ID,
      agentName: "codex",
      expectedGenerationSha256: formationDigest(retired.generation),
      nextVector: repeatedlyRetired,
      nextAgentProfile: nextProfileText,
    })).toThrow("preserve every lane authority");
    expect(() => store.prepareSnapshot({
      operationId: "fresh-after-retirement",
      caller: human,
      workspaceId: "workspace-test",
      agentId: AGENT_ID,
      agentName: "codex",
      runtimeTrustClass: "codex-v1",
      expectedGenerationSha256: formationDigest(retired.generation),
    })).toThrow("changed or retired");
  });
});
