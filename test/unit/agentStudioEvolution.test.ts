import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvolutionStore } from "../../src/evolution/EvolutionStore.js";
import {
  readEvolutionStudioCandidateDetail,
  readEvolutionStudioOverview,
} from "../../src/evolution/studioProjection.js";
import {
  AGENT_STUDIO_DOMAIN_MESSAGE_NAMES,
  createAgentEvolutionLabels,
  validateAgentStudioHostDomainMessage,
  validateAgentStudioInboundMessage,
} from "../../src/webview/agent-studio-shell/domain.js";
import {
  approveEvolutionCandidateMessage,
  evolutionCandidateDetailMessage,
  evolutionCandidatesMessage,
  evolutionSummaryMessage,
  loadEvolutionCandidateMessage,
  refreshEvolutionMessage,
  rejectEvolutionCandidateMessage,
} from "../../src/webview/agent-studio-shell/messages.js";
import { assertNoDomainNameCollision } from "../../src/webview/shared/studio/protocol.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function populatedStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tachyon-evolution-studio-"));
  roots.push(root);
  const ids = ["profile-one", "one", "two"];
  const store = new EvolutionStore(root, {
    now: () => "2026-07-21T18:00:00.000Z",
    uuid: () => ids.shift()!,
  });
  const { review } = await store.createReview("Ada", {
    taskId: "t-123456",
    taskTitle: "Fix the repository",
    completionRevision: "a".repeat(64),
    session: "tachyon-Ada",
  });
  const submission = await store.submitReview("Ada", review.id, [
    {
      kind: "learning",
      content: "Run the focused test before the full suite.",
      reason: "This shortened diagnosis.",
    },
    {
      kind: "skill",
      operation: "create",
      name: "repo-check",
      reason: "Reuse the repository verification procedure.",
      files: [
        { path: "SKILL.md", content: "---\nname: repo-check\ndescription: Verify the repository.\n---\n\nRun the script.\n" },
        { path: "scripts/check.sh", content: "#!/bin/sh\nnpm test\n", executable: true },
      ],
    },
  ]);
  return { store, review, candidates: submission.candidates };
}

describe("Agent Studio Evolution projection", () => {
  it("keeps lists bounded and loads exact learning/skill contents only on demand", async () => {
    const { store, review, candidates } = await populatedStore();
    const overview = await readEvolutionStudioOverview(store, "Ada", true);
    expect(overview.summary).toMatchObject({
      agent: "Ada",
      enabled: true,
      profilePresent: true,
      activeVersion: 0,
      pendingCount: 2,
      lastReview: { id: review.id, taskTitle: "Fix the repository", status: "submitted" },
    });
    expect(overview.candidates).toHaveLength(2);
    expect(JSON.stringify(overview)).not.toContain("#!/bin/sh");

    const learning = await readEvolutionStudioCandidateDetail(store, "Ada", candidates[0]!.id);
    expect(learning).toMatchObject({
      kind: "learning",
      taskTitle: "Fix the repository",
      expectedActiveVersion: 0,
      learningContent: "Run the focused test before the full suite.",
    });

    const skill = await readEvolutionStudioCandidateDetail(store, "Ada", candidates[1]!.id);
    expect(skill).toMatchObject({
      kind: "skill",
      skillName: "repo-check",
      expectedActiveVersion: 0,
      files: expect.arrayContaining([{ path: "scripts/check.sh", content: "#!/bin/sh\nnpm test\n", executable: true }]),
    });
    expect(skill.currentFiles).toBeUndefined();

    await store.approveCandidate("Ada", candidates[0]!.id, {
      expectedActiveVersion: 0,
      expectedTargetDigest: learning.expectedTargetDigest,
    });
    const promoted = await readEvolutionStudioOverview(store, "Ada", true);
    expect(promoted.summary).toMatchObject({ activeVersion: 1, pendingCount: 1 });
    expect(promoted.summary.activeLearnings).toEqual([
      expect.objectContaining({ content: "Run the focused test before the full suite." }),
    ]);
    expect(promoted.candidates.find((candidate) => candidate.id === candidates[0]!.id)?.status).toBe("approved");
  });

  it("projects a failed last review without inventing a proposal", async () => {
    const { store } = await populatedStore();
    const second = await store.createReview("Ada", {
      taskId: "t-654321",
      taskTitle: "Task with unavailable session",
      completionRevision: "b".repeat(64),
      session: "tachyon-Ada",
    });
    await store.markReviewFailed("Ada", second.review.id, "the assigned session exited");
    const overview = await readEvolutionStudioOverview(store, "Ada", true);
    expect(overview.summary.lastReview).toMatchObject({
      taskId: "t-654321",
      status: "failed",
      failure: "the assigned session exited",
    });
  });
});

describe("Agent Studio Evolution protocol and component contract", () => {
  it("accepts exact refresh/detail/action envelopes and rejects stale or extra fields", () => {
    expect(() => assertNoDomainNameCollision(AGENT_STUDIO_DOMAIN_MESSAGE_NAMES)).not.toThrow();
    expect(validateAgentStudioInboundMessage(refreshEvolutionMessage("Ada"))).toEqual({ type: "refreshEvolution", agent: "Ada" });
    expect(validateAgentStudioInboundMessage(loadEvolutionCandidateMessage("Ada", "candidate-one")))
      .toEqual({ type: "loadEvolutionCandidate", agent: "Ada", candidateId: "candidate-one" });
    expect(validateAgentStudioInboundMessage(approveEvolutionCandidateMessage("Ada", "candidate-one", 3, "a".repeat(64))))
      .toMatchObject({ type: "approveEvolutionCandidate", expectedActiveVersion: 3, expectedTargetDigest: "a".repeat(64) });
    expect(validateAgentStudioInboundMessage(rejectEvolutionCandidateMessage("Ada", "candidate-one", 3)))
      .toMatchObject({ type: "rejectEvolutionCandidate", expectedActiveVersion: 3 });
    expect(validateAgentStudioInboundMessage({
      ...approveEvolutionCandidateMessage("Ada", "candidate-one", 3),
      approved: true,
    })).toBeUndefined();
    expect(validateAgentStudioInboundMessage(approveEvolutionCandidateMessage("Ada", "candidate-one", -1))).toBeUndefined();
  });

  it("validates projected host summary/list/detail independently", () => {
    const summary = {
      agent: "Ada",
      enabled: true,
      profilePresent: true,
      activeVersion: 1,
      pendingCount: 1,
      activeLearnings: [],
      activeSkillNames: [],
    };
    const candidate = {
      id: "candidate-one",
      reviewId: "review-one",
      taskId: "t-123456",
      createdAt: "2026-07-21T18:00:00.000Z",
      status: "pending" as const,
      kind: "skill" as const,
      reason: "Reusable procedure.",
      operation: "create" as const,
      skillName: "repo-check",
    };
    expect(validateAgentStudioHostDomainMessage(evolutionSummaryMessage(summary))).toBe(true);
    expect(validateAgentStudioHostDomainMessage(evolutionCandidatesMessage("Ada", [candidate]))).toBe(true);
    expect(validateAgentStudioHostDomainMessage(evolutionCandidateDetailMessage("Ada", {
      ...candidate,
      expectedActiveVersion: 1,
      files: [{ path: "SKILL.md", content: "---\nname: repo-check\n---\n" }],
    }))).toBe(true);
  });

  it("keeps Identity, Persistent Instructions, and Agent Evolution as separate component regions", () => {
    const app = fs.readFileSync(path.resolve("src/webview/agent-studio-shell/App.tsx"), "utf8");
    const section = fs.readFileSync(path.resolve("src/webview/agent-studio-shell/EvolutionSection.tsx"), "utf8");
    expect(app.indexOf("Identity (SOUL.md)")).toBeLessThan(app.indexOf("Persistent instructions"));
    expect(app.indexOf("Persistent instructions")).toBeLessThan(app.indexOf("<EvolutionSection"));
    expect(app).toContain('onToggle={(enabled) => set("selfEvolution", enabled)}');
    expect(section).toContain("labels.nextSession");
    expect(section).toContain("detail.currentFiles");
    expect(section).toContain('selected.status === "pending"');
    expect(section).toContain('notice.kind === "error"');
  });

  it("creates host-localizable labels without embedding locale decisions in the component", () => {
    const labels = createAgentEvolutionLabels((message) => `pt:${message}`);
    expect(labels.title).toBe("pt:Agent Evolution");
    expect(labels.nextSession).toContain("pt:Approved changes");
    const pt = JSON.parse(fs.readFileSync(path.resolve("l10n/bundle.l10n.pt-br.json"), "utf8")) as Record<string, string>;
    expect(pt["Agent Evolution"]).toBe("Evolução do agente");
    expect(pt["Approved changes are available only in the next fresh session. The current session does not change."])
      .toContain("próxima sessão");
  });
});
