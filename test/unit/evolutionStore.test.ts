import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVOLUTION_SCHEMA_VERSION,
  renderEvolutionLearnings,
  type EvolutionHistoryRecord,
  type EvolutionLearning,
} from "../../src/evolution/domain.js";
import { EvolutionStore, EvolutionStoreError } from "../../src/evolution/EvolutionStore.js";
import {
  digestEvolutionSkillFiles,
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
});

describe("EvolutionStore (SDD 421 Slice 1)", () => {
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
});
