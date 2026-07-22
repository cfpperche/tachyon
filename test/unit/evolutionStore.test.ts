import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVOLUTION_SCHEMA_VERSION,
  renderEvolutionLearnings,
  type EvolutionHistoryRecord,
  type EvolutionLearning,
} from "../../src/evolution/domain.js";
import { EvolutionStore, EvolutionStoreError } from "../../src/evolution/EvolutionStore.js";
import type { AuthorityHead, AuthorityHeadPort } from "../../src/delivery/authorityIntegrity.js";
import { resolveEvolutionStartupSnapshot } from "../../src/evolution/startupSnapshot.js";
import {
  digestEvolutionSkillFiles,
  declaredHarnessSkillNames,
  validateEvolutionSkillBundle,
  type EvolutionSkillBundleInput,
} from "../../src/evolution/skillBundle.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tachyon-evolution-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function skillInput(name = "repo-check"): EvolutionSkillBundleInput {
  return {
    operation: "create",
    name,
    reason: "Reuse the repository check after future edits.",
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: Run the repository check consistently.\n---\n\nUse the helper script.\n`,
      },
      { path: "references/notes.md", content: "The check is local.\n" },
      { path: "scripts/check.sh", content: "#!/bin/sh\nnpm test\n", executable: true },
    ],
  };
}

function authorityHarness(options: {
  throwAfterMove?: boolean;
  throwBeforeMove?: boolean;
  throwCurrentAfterMove?: boolean;
  throwBeforeInitial?: boolean;
  throwAfterInitial?: boolean;
  throwCurrentAfterInitialFailure?: boolean;
} = {}): { key: Buffer; port: AuthorityHeadPort } {
  const heads = new Map<string, AuthorityHead>();
  let initialFaultInjected = false;
  let currentFaultPending = false;
  let moveCurrentFaultPending = false;
  return {
    key: crypto.createHash("sha256").update("evolution-test-authority").digest(),
    port: {
      current: async (identity) => {
        if (moveCurrentFaultPending) {
          moveCurrentFaultPending = false;
          throw new Error("moved head read failed");
        }
        if (currentFaultPending) {
          currentFaultPending = false;
          throw new Error("initial head read failed");
        }
        return heads.get(identity);
      },
      establishInitial: async (identity, head) => {
        const inject = !initialFaultInjected && (options.throwBeforeInitial || options.throwAfterInitial);
        if (inject) initialFaultInjected = true;
        if (inject && options.throwBeforeInitial) {
          currentFaultPending = options.throwCurrentAfterInitialFailure ?? false;
          throw new Error("initial head write failed");
        }
        const current = heads.get(identity);
        if (current && (current.revision !== head.revision || current.mac !== head.mac)) throw new Error("head conflict");
        heads.set(identity, { ...head });
        if (inject && options.throwAfterInitial) throw new Error("initial head acknowledgement lost");
      },
      prepare: async (identity, next, expectedMac) => {
        const current = heads.get(identity);
        if (!current || current.mac !== expectedMac || next.revision !== current.revision + 1) throw new Error("head conflict");
        heads.set(identity, { ...next });
      },
      retire: async (identity, expectedMac) => {
        const current = heads.get(identity);
        if (!current) return;
        if (expectedMac !== undefined && current.mac !== expectedMac) throw new Error("head conflict");
        heads.delete(identity);
      },
      move: async (fromIdentity, toIdentity, next, expectedMac) => {
        if (options.throwBeforeMove) {
          options.throwBeforeMove = false;
          moveCurrentFaultPending = options.throwCurrentAfterMove ?? false;
          throw new Error("move write failed");
        }
        const current = heads.get(fromIdentity);
        const destination = heads.get(toIdentity);
        if (!current || current.mac !== expectedMac) {
          if (!current && destination?.revision === next.revision && destination.mac === next.mac) return;
          throw new Error("head conflict");
        }
        if (destination && (destination.revision !== next.revision || destination.mac !== next.mac)) throw new Error("head conflict");
        heads.delete(fromIdentity);
        heads.set(toIdentity, { ...next });
        if (options.throwAfterMove) {
          moveCurrentFaultPending = options.throwCurrentAfterMove ?? false;
          throw new Error("move acknowledgement lost");
        }
      },
    },
  };
}

describe("Agent Skills bundle validation (SDD 421)", () => {
  it("accepts the standard bundle plus scripts/references/assets and computes a stable digest", () => {
    const input = {
      ...skillInput(),
      files: [...skillInput().files, { path: "assets/example.txt", content: "fixture\n" }],
    };
    const result = validateEvolutionSkillBundle(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.frontmatter).toEqual({
      name: "repo-check",
      description: "Run the repository check consistently.",
    });
    expect(result.bundle.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/example.txt",
      "references/notes.md",
      "scripts/check.sh",
    ]);
    expect(result.bundle.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bundle.digest).toBe(digestEvolutionSkillFiles([...result.bundle.files].reverse()));
  });

  it("rejects incomplete, mismatched, colliding, or escaping bundles", () => {
    const missing = validateEvolutionSkillBundle({ ...skillInput(), files: [] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors).toContain("skill bundle requires SKILL.md");

    const mismatched = validateEvolutionSkillBundle({ ...skillInput("expected-name"), name: "different-name" });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.errors.some((error) => error.includes("must match target skill"))).toBe(true);

    const invalidFiles = validateEvolutionSkillBundle({
      ...skillInput(),
      files: [
        ...skillInput().files,
        { path: "../escape.sh", content: "no" },
        { path: "SKILL.md", content: skillInput().files[0]!.content },
      ],
    });
    expect(invalidFiles.ok).toBe(false);
    if (!invalidFiles.ok) {
      expect(invalidFiles.errors.some((error) => error.includes("must be SKILL.md"))).toBe(true);
      expect(invalidFiles.errors).toContain("skill file 'SKILL.md' is duplicated");
    }

    const updateWithoutDigest = validateEvolutionSkillBundle({ ...skillInput(), operation: "update" });
    expect(updateWithoutDigest.ok).toBe(false);
    if (!updateWithoutDigest.ok) expect(updateWithoutDigest.errors.some((error) => error.includes("expectedTargetDigest"))).toBe(true);
  });

  it("reserves human-declared harness skill names from both path and standard frontmatter", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, "skills", "folder-name"), { recursive: true });
    await fs.writeFile(
      path.join(root, "skills", "folder-name", "SKILL.md"),
      "---\nname: declared-name\ndescription: Human-owned skill.\n---\n",
      "utf8",
    );
    expect(declaredHarnessSkillNames(root, ["skills/folder-name", "skills/missing-name"]))
      .toEqual(new Set(["folder-name", "declared-name", "missing-name"]));
  });
});

describe("EvolutionStore (SDD 421 Slice 1)", () => {
  it("recovers when creation stops after the authenticated intent but before profile bytes", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const interrupted = new EvolutionStore(root, {
      ...options,
      creationFault: () => { throw new Error("creation interrupted"); },
    });

    await expect(interrupted.ensureProfile("reviewer")).rejects.toThrow("creation interrupted");
    await expect(fs.stat(interrupted.profilePath("reviewer"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(interrupted.creationIntentPath("reviewer"))).toBeDefined();
    await expect(new EvolutionStore(root, options).ensureProfile("reviewer"))
      .resolves.toMatchObject({ agent: "reviewer", activeVersion: 0 });
    await expect(fs.stat(interrupted.creationIntentPath("reviewer"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a signed initial profile after authority write and confirmation were unavailable", async () => {
    const root = await tempRoot();
    const authority = authorityHarness({ throwBeforeInitial: true, throwCurrentAfterInitialFailure: true });
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, options);

    await expect(store.ensureProfile("reviewer")).rejects.toThrow("initial head write failed");
    const pending = await store.readProfile("reviewer").catch(() => undefined);
    expect(pending).toBeUndefined();
    expect(await fs.stat(store.creationIntentPath("reviewer"))).toBeDefined();
    const recovered = await new EvolutionStore(root, options).ensureProfile("reviewer");
    expect(recovered).toMatchObject({ agent: "reviewer", activeVersion: 0 });
    await expect(fs.stat(store.creationIntentPath("reviewer"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts initial profile creation when only the authority acknowledgement is lost", async () => {
    const root = await tempRoot();
    const authority = authorityHarness({ throwAfterInitial: true });
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, options);

    const profile = await store.ensureProfile("reviewer");
    expect(profile).toMatchObject({ agent: "reviewer" });
    await expect(new EvolutionStore(root, options).readProfile("reviewer")).resolves.toEqual(profile);
  });

  it("rejects captured bytes that were restored before the final authority read", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, options);
    await store.ensureProfile("reviewer");
    const approved = renderEvolutionLearnings([]);
    const current = authority.port.current.bind(authority.port);
    let reads = 0;
    authority.port.current = async (identity) => {
      const head = await current(identity);
      reads += 1;
      if (reads === 1) await fs.writeFile(store.learningsPath("reviewer"), renderEvolutionLearnings([{
        id: "transient",
        sourceTaskId: "t-999999",
        sourceReviewId: "review-transient",
        approvedAt: "2026-07-21T20:00:00.000Z",
        content: "Unapproved transient content.",
      }]), "utf8");
      if (reads === 2) await fs.writeFile(store.learningsPath("reviewer"), approved, "utf8");
      return head;
    };

    await expect(store.readAuthorizedActiveState("reviewer"))
      .rejects.toMatchObject({ code: "evolution/authority-invalid" });
    expect(await fs.readFile(store.learningsPath("reviewer"), "utf8")).toBe(approved);
  });

  it("accepts a rename whose authority move committed before its acknowledgement failed", async () => {
    const root = await tempRoot();
    const authority = authorityHarness({ throwAfterMove: true });
    const store = new EvolutionStore(root, {
      authorityIntegrityKey: () => authority.key,
      authorityHead: authority.port,
      retiredRootCleanup: async () => { throw new Error("recursive cleanup failed"); },
    });
    const profile = await store.ensureProfile("reviewer");

    await expect(store.renameAgent("reviewer", "maintainer")).resolves.toBe(true);
    await expect(store.readProfile("maintainer")).resolves.toMatchObject({ profileId: profile.profileId });
    await expect(store.readProfile("reviewer")).resolves.toBeUndefined();
    await expect(store.ensureProfile("reviewer")).resolves.not.toMatchObject({ profileId: profile.profileId });
  });

  it("recovers a journaled rename when move acknowledgement and confirmation both fail", async () => {
    const root = await tempRoot();
    const authority = authorityHarness({ throwAfterMove: true, throwCurrentAfterMove: true });
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, options);
    const profile = await store.ensureProfile("reviewer");

    await expect(store.renameAgent("reviewer", "maintainer")).resolves.toBe(true);
    expect(await fs.stat(store.renameIntentPath("maintainer"))).toBeDefined();
    await expect(new EvolutionStore(root, options).ensureProfile("maintainer"))
      .resolves.toMatchObject({ profileId: profile.profileId });
    await expect(fs.stat(store.renameIntentPath("maintainer"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles an uncommitted journaled rename before retiring the renamed agent", async () => {
    const root = await tempRoot();
    const authority = authorityHarness({ throwBeforeMove: true, throwCurrentAfterMove: true });
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, options);
    await store.ensureProfile("reviewer");

    await expect(store.renameAgent("reviewer", "maintainer")).resolves.toBe(true);
    expect(await fs.stat(store.renameIntentPath("maintainer"))).toBeDefined();
    await expect(store.retireAgent("maintainer")).resolves.toBeUndefined();
    await fs.rm(store.rootFor("maintainer"), { recursive: true, force: true });
    await expect(new EvolutionStore(root, options).ensureProfile("maintainer"))
      .resolves.toMatchObject({ agent: "maintainer", activeVersion: 0 });
  });

  it("quarantines the old source when retrying a crash after destination publication", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const interrupted = new EvolutionStore(root, {
      ...options,
      renameFault: () => { throw new Error("rename interrupted after publication"); },
    });
    const profile = await interrupted.ensureProfile("reviewer");

    await expect(interrupted.renameAgent("reviewer", "maintainer"))
      .rejects.toThrow("rename interrupted after publication");
    expect(await fs.stat(interrupted.rootFor("reviewer"))).toBeDefined();
    await expect(new EvolutionStore(root, options).renameAgent("reviewer", "maintainer")).resolves.toBe(true);
    await expect(new EvolutionStore(root, options).readProfile("maintainer"))
      .resolves.toMatchObject({ profileId: profile.profileId });
    await expect(fs.stat(interrupted.rootFor("reviewer"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new EvolutionStore(root, options).ensureProfile("reviewer"))
      .resolves.not.toMatchObject({ profileId: profile.profileId });
  });

  it("leaves the old profile authoritative when source quarantine fails before rename commit", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const store = new EvolutionStore(root, {
      authorityIntegrityKey: () => authority.key,
      authorityHead: authority.port,
      quarantineRoot: async () => { throw new Error("source quarantine failed"); },
    });
    const profile = await store.ensureProfile("reviewer");

    await expect(store.renameAgent("reviewer", "maintainer")).rejects.toThrow("source quarantine failed");
    await expect(store.readProfile("reviewer")).resolves.toEqual(profile);
    await expect(store.readProfile("maintainer")).resolves.toBeUndefined();
  });

  it("fails closed when active learning bytes do not match the host-authorized head", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, options);
    const candidate = await store.createCandidate("reviewer", {
      reviewId: "review-authority",
      taskId: "t-111111",
      target: { kind: "learning", content: "Approved fact.", reason: "Reusable." },
    });
    const detail = await store.candidateDetail("reviewer", candidate.id);
    await store.approveCandidate("reviewer", candidate.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: detail.currentTargetDigest,
    });
    await fs.appendFile(store.learningsPath("reviewer"), "unapproved edit\n", "utf8");

    await expect(resolveEvolutionStartupSnapshot(root, "reviewer", new EvolutionStore(root, options)))
      .rejects.toMatchObject({ code: "evolution/authority-invalid" });
  });

  it("does not treat an edited profile id as a new legacy authority identity", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, options);
    const profile = await store.ensureProfile("reviewer");
    await fs.writeFile(store.profilePath("reviewer"), `${JSON.stringify({ ...profile, profileId: "forged-profile" }, null, 2)}\n`, "utf8");
    await expect(new EvolutionStore(root, options).readProfile("reviewer"))
      .rejects.toMatchObject({ code: "evolution/authority-invalid" });
  });

  it("rolls back a durable promotion intent left before active bytes changed", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    let injected = false;
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, {
      ...options,
      promotionFault: (point) => {
        if (!injected && point === "after-intent") { injected = true; throw new Error("simulated crash"); }
      },
    });
    const candidate = await store.createCandidate("reviewer", {
      reviewId: "review-recovery",
      taskId: "t-222222",
      target: { kind: "learning", content: "Recoverable fact.", reason: "Reusable." },
    });
    const detail = await store.candidateDetail("reviewer", candidate.id);
    await expect(store.approveCandidate("reviewer", candidate.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: detail.currentTargetDigest,
    })).rejects.toThrow("simulated crash");
    expect(await fs.stat(store.promotionIntentPath("reviewer"))).toBeDefined();

    const reloaded = new EvolutionStore(root, options);
    expect((await reloaded.ensureProfile("reviewer")).activeVersion).toBe(0);
    expect((await reloaded.readCandidate("reviewer", candidate.id))?.status).toBe("pending");
    expect(await fs.readFile(reloaded.learningsPath("reviewer"), "utf8")).toBe(renderEvolutionLearnings([]));
    await expect(fs.stat(reloaded.promotionIntentPath("reviewer"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["after-target", "after-history", "after-profile", "after-candidate"] as const)(
    "restores the authorized learning profile when promotion fails at %s",
    async (faultPoint) => {
      const root = await tempRoot();
      const authority = authorityHarness();
      const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
      const store = new EvolutionStore(root, {
        ...options,
        promotionFault: (point) => { if (point === faultPoint) throw new Error(`fault:${point}`); },
      });
      const candidate = await store.createCandidate("reviewer", {
        reviewId: `review-${faultPoint}`,
        taskId: "t-333333",
        target: { kind: "learning", content: `Fact for ${faultPoint}.`, reason: "Recovery proof." },
      });
      const detail = await store.candidateDetail("reviewer", candidate.id);
      await expect(store.approveCandidate("reviewer", candidate.id, {
        expectedActiveVersion: 0,
        expectedTargetDigest: detail.currentTargetDigest,
      })).rejects.toThrow(`fault:${faultPoint}`);
      const reloaded = new EvolutionStore(root, options);
      expect((await reloaded.ensureProfile("reviewer")).activeVersion).toBe(0);
      expect((await reloaded.readCandidate("reviewer", candidate.id))?.status).toBe("pending");
      expect(await reloaded.readLearnings("reviewer")).toEqual([]);
    },
  );

  it("restores a previous skill bundle when an update fails after replacing its files", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const initial = new EvolutionStore(root, options);
    const created = await initial.createCandidate("reviewer", {
      reviewId: "review-create-skill",
      taskId: "t-444444",
      target: { kind: "skill", ...skillInput() },
    });
    await initial.approveCandidate("reviewer", created.id, { expectedActiveVersion: 0 });
    const previous = await initial.readSkillFiles("reviewer", "repo-check");
    const previousDigest = digestEvolutionSkillFiles(previous!);
    const updateInput = skillInput();
    updateInput.operation = "update";
    updateInput.expectedTargetDigest = previousDigest;
    updateInput.files = updateInput.files.map((file) => file.path === "scripts/check.sh"
      ? { ...file, content: "#!/bin/sh\nnpm run typecheck\n" }
      : file);
    const updated = await initial.createCandidate("reviewer", {
      reviewId: "review-update-skill",
      taskId: "t-555555",
      target: { kind: "skill", ...updateInput },
    });
    const failing = new EvolutionStore(root, {
      ...options,
      promotionFault: (point) => { if (point === "after-target") throw new Error("skill update interrupted"); },
    });
    await expect(failing.approveCandidate("reviewer", updated.id, {
      expectedActiveVersion: 1,
      expectedTargetDigest: previousDigest,
    })).rejects.toThrow("skill update interrupted");
    const reloaded = new EvolutionStore(root, options);
    expect((await reloaded.ensureProfile("reviewer")).activeVersion).toBe(1);
    expect(await reloaded.readSkillFiles("reviewer", "repo-check")).toEqual(previous);
    expect((await reloaded.readCandidate("reviewer", updated.id))?.status).toBe("pending");
  });

  it("returns the committed result when interruption happens after the authority head advanced", async () => {
    const root = await tempRoot();
    const authority = authorityHarness();
    const options = { authorityIntegrityKey: () => authority.key, authorityHead: authority.port };
    const store = new EvolutionStore(root, {
      ...options,
      promotionFault: (point) => { if (point === "after-authority") throw new Error("late interruption"); },
    });
    const candidate = await store.createCandidate("reviewer", {
      reviewId: "review-late-interruption",
      taskId: "t-666666",
      target: { kind: "learning", content: "Committed fact.", reason: "Recovery proof." },
    });
    const detail = await store.candidateDetail("reviewer", candidate.id);
    await expect(store.approveCandidate("reviewer", candidate.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: detail.currentTargetDigest,
    })).resolves.toMatchObject({ profile: { activeVersion: 1 }, candidate: { status: "approved" } });
    await expect(resolveEvolutionStartupSnapshot(root, "reviewer", new EvolutionStore(root, options)))
      .resolves.toMatchObject({ version: 1 });
  });
  it("moves a complete profile to a renamed agent while preserving identity, version, and skill bytes", async () => {
    const root = await tempRoot();
    const ids = ["profile-id", "review-id", "rename-stage"];
    const store = new EvolutionStore(root, {
      now: () => "2026-07-21T18:00:00.000Z",
      uuid: () => ids.shift()!,
    });
    const { review } = await store.createReview("reviewer", {
      taskId: "t-123456",
      taskTitle: "Review repository",
      completionRevision: "a".repeat(64),
      session: "tachyon-reviewer",
    });
    const { candidates } = await store.submitReview("reviewer", review.id, [
      { kind: "learning", content: "Run focused tests first.", reason: "Faster feedback." },
      { kind: "skill", ...skillInput() },
    ]);
    const learningDetail = await store.candidateDetail("reviewer", candidates[0]!.id);
    await store.approveCandidate("reviewer", candidates[0]!.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: learningDetail.currentTargetDigest,
    });
    await store.approveCandidate("reviewer", candidates[1]!.id, { expectedActiveVersion: 1 });
    const before = await store.readProfile("reviewer");
    const skillBefore = await store.readSkillFiles("reviewer", "repo-check");

    await expect(store.renameAgent("reviewer", "maintainer")).resolves.toBe(true);
    expect(await store.readProfile("reviewer")).toBeUndefined();
    expect(await store.readProfile("maintainer")).toMatchObject({
      profileId: before!.profileId,
      agent: "maintainer",
      activeVersion: 2,
    });
    expect((await store.listReviews("maintainer")).map((item) => item.agent)).toEqual(["maintainer"]);
    expect((await store.listCandidates("maintainer")).map((item) => item.agent)).toEqual(["maintainer", "maintainer"]);
    expect(await store.readSkillFiles("maintainer", "repo-check")).toEqual(skillBefore);
    const historyFiles = await fs.readdir(store.historyDir("maintainer"));
    const history = JSON.parse(await fs.readFile(path.join(store.historyDir("maintainer"), historyFiles[0]!), "utf8"));
    expect(history.agent).toBe("maintainer");
  });

  it("refuses a rename onto an existing profile and leaves both profiles unchanged", async () => {
    const root = await tempRoot();
    const ids = ["reviewer-profile", "maintainer-profile"];
    const store = new EvolutionStore(root, { uuid: () => ids.shift()! });
    const reviewer = await store.ensureProfile("reviewer");
    const maintainer = await store.ensureProfile("maintainer");

    await expect(store.renameAgent("reviewer", "maintainer")).rejects.toMatchObject({
      code: "evolution/profile-conflict",
    });
    expect(await store.readProfile("reviewer")).toEqual(reviewer);
    expect(await store.readProfile("maintainer")).toEqual(maintainer);
  });

  it("creates and reloads the canonical profile without changing active version", async () => {
    const root = await tempRoot();
    const ids = ["profile-id", "candidate-id"];
    const store = new EvolutionStore(root, {
      now: () => "2026-07-21T18:00:00.000Z",
      uuid: () => ids.shift()!,
    });

    const profile = await store.ensureProfile("reviewer");
    expect(profile).toEqual({
      schemaVersion: EVOLUTION_SCHEMA_VERSION,
      profileId: "profile-id",
      agent: "reviewer",
      activeVersion: 0,
      createdAt: "2026-07-21T18:00:00.000Z",
      updatedAt: "2026-07-21T18:00:00.000Z",
    });
    expect(await fs.readFile(store.learningsPath("reviewer"), "utf8")).toBe(renderEvolutionLearnings([]));

    const reloaded = new EvolutionStore(root);
    expect(await reloaded.readProfile("reviewer")).toEqual(profile);
    expect(await reloaded.listCandidates("reviewer")).toEqual([]);

    await fs.rm(store.learningsPath("reviewer"));
    expect(await reloaded.ensureProfile("reviewer")).toEqual(profile);
    expect(await fs.readFile(store.learningsPath("reviewer"), "utf8")).toBe(renderEvolutionLearnings([]));
  });

  it("stores unrelated candidates independently and blocks two pending candidates for one skill", async () => {
    const root = await tempRoot();
    const ids = ["profile-id", "learning-id", "skill-id", "other-skill-id", "collision-id"];
    const store = new EvolutionStore(root, {
      now: () => "2026-07-21T18:00:00.000Z",
      uuid: () => ids.shift()!,
    });

    const [learning, skill] = await Promise.all([
      store.createCandidate("reviewer", {
        reviewId: "review-1",
        taskId: "t-123456",
        target: { kind: "learning", content: " Prefer the focused check first. ", reason: " It shortened diagnosis. " },
      }),
      store.createCandidate("reviewer", {
        reviewId: "review-1",
        taskId: "t-123456",
        target: { kind: "skill", ...skillInput() },
      }),
    ]);
    expect(learning.target).toEqual({ kind: "learning", content: "Prefer the focused check first.", reason: "It shortened diagnosis." });
    expect(skill.target.kind).toBe("skill");
    expect((await store.readProfile("reviewer"))?.activeVersion).toBe(0);

    const other = await store.createCandidate("reviewer", {
      reviewId: "review-2",
      taskId: "t-abcdef",
      target: { kind: "skill", ...skillInput("docs-check") },
    });
    expect(other.target.kind === "skill" ? other.target.name : undefined).toBe("docs-check");

    await expect(store.createCandidate("reviewer", {
      reviewId: "review-3",
      taskId: "t-fedcba",
      target: { kind: "skill", ...skillInput() },
    })).rejects.toMatchObject({ code: "evolution/candidate-conflict" } satisfies Partial<EvolutionStoreError>);
    expect(await store.listCandidates("reviewer")).toHaveLength(3);
    expect((await store.readProfile("reviewer"))?.activeVersion).toBe(0);
  });

  it("renders approved learning entries deterministically and records history separately", async () => {
    const root = await tempRoot();
    const store = new EvolutionStore(root, { uuid: () => "profile-id" });
    const entries: EvolutionLearning[] = [
      { id: "later", content: "Use the release checklist.", sourceTaskId: "t-2", sourceReviewId: "r-2", approvedAt: "2026-07-21T19:00:00.000Z" },
      { id: "earlier", content: "Run the focused test first.", sourceTaskId: "t-1", sourceReviewId: "r-1", approvedAt: "2026-07-21T18:00:00.000Z" },
    ];
    await store.writeLearnings("reviewer", entries);
    const rendered = await fs.readFile(store.learningsPath("reviewer"), "utf8");
    expect(rendered.indexOf("earlier")).toBeLessThan(rendered.indexOf("later"));

    const history: EvolutionHistoryRecord = {
      schemaVersion: 1,
      id: "promotion-1",
      agent: "reviewer",
      version: 1,
      candidateId: "candidate-1",
      target: "learning",
      recordedAt: "2026-07-21T20:00:00.000Z",
      promotedDigest: "a".repeat(64),
    };
    await store.recordHistory("reviewer", history);
    expect(JSON.parse(await fs.readFile(path.join(store.historyDir("reviewer"), "000001-promotion-1.json"), "utf8"))).toEqual(history);
    expect((await store.readProfile("reviewer"))?.activeVersion).toBe(0);
  });

  it("fails closed on a malformed profile", async () => {
    const root = await tempRoot();
    const store = new EvolutionStore(root);
    await fs.mkdir(store.rootFor("reviewer"), { recursive: true });
    await fs.writeFile(store.profilePath("reviewer"), "{broken", "utf8");
    await expect(store.readProfile("reviewer")).rejects.toMatchObject({
      code: "evolution/profile-malformed",
    } satisfies Partial<EvolutionStoreError>);
    await expect(store.createCandidate("reviewer", {
      reviewId: "review-1",
      taskId: "t-123456",
      target: { kind: "learning", content: "Fact", reason: "Reason" },
    })).rejects.toMatchObject({ code: "evolution/profile-malformed" } satisfies Partial<EvolutionStoreError>);
  });

  it("creates one review per completion revision and makes submission idempotent", async () => {
    const root = await tempRoot();
    const ids = ["profile-id", "review-id"];
    const store = new EvolutionStore(root, {
      now: () => "2026-07-21T18:00:00.000Z",
      uuid: () => ids.shift()!,
    });
    const input = {
      taskId: "t-123456",
      taskTitle: "Ship the change",
      completionRevision: "b".repeat(64),
      session: "tachyon-reviewer",
      activitySeq: 42,
    };
    const first = await store.createReview("reviewer", input);
    const duplicate = await store.createReview("reviewer", input);
    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ review: first.review, created: false });
    expect(await store.listReviews("reviewer")).toHaveLength(1);

    const delivered = await store.markReviewDelivery("reviewer", first.review.id, "queued");
    expect(delivered.delivery.status).toBe("queued");
    const proposals = [
      { kind: "learning" as const, content: "Use the focused test first.", reason: "It shortened diagnosis." },
      { kind: "skill" as const, ...skillInput() },
    ];
    const submitted = await store.submitReview("reviewer", first.review.id, proposals);
    expect(submitted.replayed).toBe(false);
    expect(submitted.review.status).toBe("submitted");
    expect(submitted.candidates.map((candidate) => candidate.id)).toEqual([
      "candidate-review-id-1",
      "candidate-review-id-2",
    ]);
    expect((await store.readProfile("reviewer"))?.activeVersion).toBe(0);

    const replay = await store.submitReview("reviewer", first.review.id, proposals);
    expect(replay.replayed).toBe(true);
    expect(replay.review).toEqual(submitted.review);
    await expect(store.submitReview("reviewer", first.review.id, [])).rejects.toMatchObject({
      code: "evolution/review-conflict",
    } satisfies Partial<EvolutionStoreError>);
  });

  it("records an empty review or a visible delivery failure without candidates", async () => {
    const root = await tempRoot();
    const ids = ["profile-id", "empty-review", "failed-review"];
    const store = new EvolutionStore(root, { uuid: () => ids.shift()! });
    const empty = await store.createReview("reviewer", {
      taskId: "t-111111",
      taskTitle: "No learning",
      completionRevision: "c".repeat(64),
      session: "tachyon-reviewer",
    });
    const noProposal = await store.submitReview("reviewer", empty.review.id, []);
    expect(noProposal.review.status).toBe("no-proposal");
    expect(noProposal.candidates).toEqual([]);

    const failed = await store.createReview("reviewer", {
      taskId: "t-222222",
      taskTitle: "Session gone",
      completionRevision: "d".repeat(64),
      session: "tachyon-reviewer",
    });
    const marked = await store.markReviewFailed("reviewer", failed.review.id, "agent is not running");
    expect(marked).toMatchObject({
      status: "failed",
      delivery: { status: "failed", detail: "agent is not running" },
      failure: "agent is not running",
    });
    await expect(store.submitReview("reviewer", failed.review.id, [])).rejects.toMatchObject({
      code: "evolution/review-conflict",
    } satisfies Partial<EvolutionStoreError>);
  });

  it("rejects or approves learning candidates independently with versioned history", async () => {
    const root = await tempRoot();
    const ids = ["profile-id", "keep-id", "reject-id"];
    let tick = 0;
    const store = new EvolutionStore(root, {
      uuid: () => ids.shift()!,
      now: () => new Date(Date.parse("2026-07-21T18:00:00.000Z") + tick++ * 1_000).toISOString(),
    });
    const keep = await store.createCandidate("reviewer", {
      reviewId: "review-keep",
      taskId: "t-111111",
      target: { kind: "learning", content: "Run the focused test first.", reason: "It shortened diagnosis." },
    });
    const reject = await store.createCandidate("reviewer", {
      reviewId: "review-reject",
      taskId: "t-222222",
      target: { kind: "learning", content: "Keep a temporary workaround.", reason: "It worked once." },
    });
    const detail = await store.candidateDetail("reviewer", keep.id);

    const rejected = await store.rejectCandidate("reviewer", reject.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: detail.currentTargetDigest,
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected).not.toHaveProperty("promotedVersion");
    expect((await store.readProfile("reviewer"))?.activeVersion).toBe(0);

    const promoted = await store.approveCandidate("reviewer", keep.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: detail.currentTargetDigest,
    });
    expect(promoted.candidate).toMatchObject({ status: "approved", promotedVersion: 1 });
    expect(promoted.profile.activeVersion).toBe(1);
    expect(await store.readLearnings("reviewer")).toEqual([expect.objectContaining({
      content: "Run the focused test first.",
      sourceTaskId: "t-111111",
      sourceReviewId: "review-keep",
    })]);
    expect(JSON.parse(await fs.readFile(path.join(store.historyDir("reviewer"), `000001-${promoted.history.id}.json`), "utf8")))
      .toEqual(promoted.history);
    await expect(store.approveCandidate("reviewer", keep.id, {
      expectedActiveVersion: 1,
      expectedTargetDigest: (await store.candidateDetail("reviewer", keep.id)).currentTargetDigest,
    })).rejects.toMatchObject({ code: "evolution/promotion-conflict" } satisfies Partial<EvolutionStoreError>);
  });

  it("promotes complete skill bundles, preserves the replaced bundle, and blocks stale or declared collisions", async () => {
    const root = await tempRoot();
    const ids = ["profile-id", "create-id", "update-id", "reserved-id"];
    const store = new EvolutionStore(root, {
      uuid: () => ids.shift()!,
      reservedSkillNames: () => new Set(["human-skill"]),
    });
    const created = await store.createCandidate("reviewer", {
      reviewId: "review-create",
      taskId: "t-111111",
      target: { kind: "skill", ...skillInput("repo-check") },
    });
    const createDetail = await store.candidateDetail("reviewer", created.id);
    const first = await store.approveCandidate("reviewer", created.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: createDetail.currentTargetDigest,
    });
    expect(first.profile.activeVersion).toBe(1);
    const original = await store.readSkillFiles("reviewer", "repo-check");
    expect(original?.map((file) => file.path)).toContain("scripts/check.sh");

    const originalDigest = (first.candidate.target.kind === "skill" ? first.candidate.target.digest : "");
    const updateInput: EvolutionSkillBundleInput = {
      ...skillInput("repo-check"),
      operation: "update",
      expectedTargetDigest: originalDigest,
      files: skillInput("repo-check").files.map((file) => file.path === "scripts/check.sh"
        ? { ...file, content: "#!/bin/sh\nnpm run verify:full:quiet\n" }
        : file),
    };
    const update = await store.createCandidate("reviewer", {
      reviewId: "review-update",
      taskId: "t-222222",
      target: { kind: "skill", ...updateInput },
    });
    const updateDetail = await store.candidateDetail("reviewer", update.id);
    expect(updateDetail.currentTargetDigest).toBe(originalDigest);
    await expect(store.approveCandidate("reviewer", update.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: originalDigest,
    })).rejects.toMatchObject({ code: "evolution/promotion-conflict" } satisfies Partial<EvolutionStoreError>);

    const second = await store.approveCandidate("reviewer", update.id, {
      expectedActiveVersion: 1,
      expectedTargetDigest: originalDigest,
    });
    expect(second.profile.activeVersion).toBe(2);
    expect(second.history.previousDigest).toBe(originalDigest);
    expect(second.history.previousSkillFiles).toEqual(original);
    expect((await store.readSkillFiles("reviewer", "repo-check"))?.find((file) => file.path === "scripts/check.sh")?.content)
      .toContain("verify:full:quiet");

    const reserved = await store.createCandidate("reviewer", {
      reviewId: "review-reserved",
      taskId: "t-333333",
      target: { kind: "skill", ...skillInput("human-skill") },
    });
    await expect(store.approveCandidate("reviewer", reserved.id, {
      expectedActiveVersion: 2,
      expectedTargetDigest: undefined,
    })).rejects.toMatchObject({ code: "evolution/promotion-conflict" } satisfies Partial<EvolutionStoreError>);
    expect((await store.readCandidate("reviewer", reserved.id))?.status).toBe("pending");
    expect(await store.readSkillFiles("reviewer", "human-skill")).toBeUndefined();
  });
});
