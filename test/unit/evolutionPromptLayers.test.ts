import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeAgentPrompt } from "../../src/agents/promptLayers.js";
import { renderStartupBriefInventory, renderStartupBriefSummary } from "../../src/agents/startupBrief.js";
import { EvolutionStore } from "../../src/evolution/EvolutionStore.js";
import {
  isEvolutionStartupSnapshot,
  renderEvolutionPromptLayer,
  resolveEvolutionStartupSnapshot,
} from "../../src/evolution/startupSnapshot.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tachyon-evolution-prompt-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Agent Evolution startup snapshot (SDD 421 Slice 3)", () => {
  it("resolves one immutable runtime-neutral snapshot and composes it in the approved layer order", async () => {
    const root = await tempRoot();
    const hostSnapshots = await tempRoot();
    const store = new EvolutionStore(root, { sessionSnapshotsRoot: hostSnapshots });
    const learning = await store.createCandidate("reviewer", {
      reviewId: "review-learning",
      taskId: "t-111111",
      target: { kind: "learning", content: "Run the focused test first.", reason: "It shortens diagnosis." },
    });
    const learningDetail = await store.candidateDetail("reviewer", learning.id);
    await store.approveCandidate("reviewer", learning.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: learningDetail.currentTargetDigest,
    });
    const skill = await store.createCandidate("reviewer", {
      reviewId: "review-skill",
      taskId: "t-222222",
      target: {
        kind: "skill",
        operation: "create",
        name: "repo-check",
        reason: "Reuse the repository check.",
        files: [
          { path: "SKILL.md", content: "---\nname: repo-check\ndescription: Run the repository check consistently.\n---\n\nUse the helper.\n" },
          { path: "scripts/check.sh", content: "#!/bin/sh\nnpm test\n", executable: true },
        ],
      },
    });
    await store.approveCandidate("reviewer", skill.id, {
      expectedActiveVersion: 1,
      expectedTargetDigest: undefined,
    });

    const snapshot = await resolveEvolutionStartupSnapshot(root, "reviewer", store);
    expect(snapshot).toMatchObject({ agent: "reviewer", version: 2 });
    expect(isEvolutionStartupSnapshot(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.skills)).toBe(true);
    expect(snapshot.skills[0]).toMatchObject({
      name: "repo-check",
      description: "Run the repository check consistently.",
    });
    expect(snapshot.skills[0]!.skillMdPath.startsWith(hostSnapshots)).toBe(true);
    expect(await fs.readFile(snapshot.skills[0]!.skillMdPath, "utf8")).toContain("Use the helper.");
    await fs.writeFile(path.join(store.skillDir("reviewer", "repo-check"), "SKILL.md"), "forged live skill\n", "utf8");
    expect(await fs.readFile(snapshot.skills[0]!.skillMdPath, "utf8")).toContain("Use the helper.");

    const prompt = composeAgentPrompt({
      role: "reviewer",
      instructions: "Persistent instructions.",
      evolution: snapshot,
      bridgeGuidance: true,
      taskBrief: "Current task.",
    });
    const body = prompt.body!;
    expect(body.indexOf("Persistent instructions.")).toBeLessThan(body.indexOf("## Agent Evolution"));
    expect(body.indexOf("## Agent Evolution")).toBeLessThan(body.indexOf("[Tachyon] You are part"));
    expect(body.indexOf("[Tachyon] You are part")).toBeLessThan(body.indexOf("Current task."));
    expect(body).toContain(snapshot.skills[0]!.skillMdPath);
    expect(prompt.manifest.evolution).toEqual({ version: 2, digest: snapshot.digest });
    expect(renderEvolutionPromptLayer(snapshot)).toContain("scripts/tools through your existing runtime tools");

    const startup = { projectGuidanceSources: 0, prompt: prompt.manifest };
    expect(renderStartupBriefSummary(startup)).toContain(`Agent Evolution (v2; ${snapshot.digest})`);
    expect(renderStartupBriefInventory(startup)).toContain(`version 2; digest ${snapshot.digest}`);
  });

  it("pins the complete snapshot in the ledger while later approvals create only a next-session snapshot", async () => {
    const root = await tempRoot();
    const store = new EvolutionStore(root);
    await store.ensureProfile("reviewer");
    const current = await resolveEvolutionStartupSnapshot(root, "reviewer", store);
    const ledger = new SessionLedger(root);
    ledger.record("reviewer", {
      def: { cmd: "codex", kind: "agent" },
      cwd: root,
      declared: true,
      evolution: current,
    });
    const reloaded = new SessionLedger(root).get("reviewer")?.evolution;
    expect(reloaded).toEqual(current);
    expect(Object.isFrozen(reloaded)).toBe(true);

    const learning = await store.createCandidate("reviewer", {
      reviewId: "review-next",
      taskId: "t-333333",
      target: { kind: "learning", content: "Prefer the deterministic fixture.", reason: "It avoids drift." },
    });
    const detail = await store.candidateDetail("reviewer", learning.id);
    await store.approveCandidate("reviewer", learning.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: detail.currentTargetDigest,
    });
    const next = await resolveEvolutionStartupSnapshot(root, "reviewer", store);

    expect(next.version).toBe(1);
    expect(next.digest).not.toBe(current.digest);
    expect(new SessionLedger(root).get("reviewer")?.evolution).toEqual(current);
    expect(composeAgentPrompt({ evolution: current, bridgeGuidance: false }).body).not.toContain("Prefer the deterministic fixture.");
    expect(composeAgentPrompt({ evolution: next, bridgeGuidance: false }).body).toContain("Prefer the deterministic fixture.");
    expect(await resolveEvolutionStartupSnapshot(root, "reviewer", store)).toEqual(next);
  });

  it("keeps disabled legacy prompt and startup inventory bytes free of evolution labels", () => {
    const composed = composeAgentPrompt({
      instructions: "Persistent instructions.",
      bridgeGuidance: false,
      taskBrief: "Current task.",
    });
    expect(composed.body).toBe("Persistent instructions.\n\nCurrent task.");
    expect(composed.manifest).not.toHaveProperty("evolution");
    const startup = { projectGuidanceSources: 0, prompt: composed.manifest };
    expect(renderStartupBriefSummary(startup)).not.toContain("Evolution");
    expect(renderStartupBriefInventory(startup)).not.toContain("Evolution");
  });
});
