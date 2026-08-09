import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { composeAgentPrompt } from "../../src/agents/promptLayers.js";

describe("prompt composition without Soul or Role", () => {
  it("keeps the remaining layers in their established order and omits removed manifest facts", () => {
    const instructions = "Persistent instructions.";
    const canonicalEvolution = "Canonical evolution.";
    const selectedMemory = "Selected memory.";
    const taskBrief = "Current execution task.";
    const sessionWorkRecord = {
      isolation: { kind: "shared" as const, cwd: "/workspace" },
      assignment: { current: undefined, queue: [] },
    };
    const composed = composeAgentPrompt({
      instructions,
      formationEvolution: canonicalEvolution,
      selectedMemory,
      bridgeGuidance: true,
      taskBrief,
      taskContractCompletion: "deliverable",
      sessionWorkRecord,
    });
    const body = composed.body!;
    const guidance = "[Tachyon] You are part of a Tachyon team.";
    const workRecord = "WORK ON RECORD";

    expect(body.indexOf(instructions)).toBeLessThan(body.indexOf(canonicalEvolution));
    expect(body.indexOf(canonicalEvolution)).toBeLessThan(body.indexOf(selectedMemory));
    expect(body.indexOf(selectedMemory)).toBeLessThan(body.indexOf(guidance));
    expect(body.indexOf(guidance)).toBeLessThan(body.indexOf(taskBrief));
    expect(body.indexOf(taskBrief)).toBeLessThan(body.indexOf(workRecord));
    expect(composed.manifest).toEqual({
      persistentInstructions: true,
      instructions: {
        source: "profile-definition",
        sha256: crypto.createHash("sha256").update(instructions).digest("hex"),
      },
      canonicalEvolution: true,
      selectedMemory: true,
      bridgeGuidance: true,
      task: { kind: "contract", completion: "deliverable" },
      sessionRecord: { isolation: "shared", assignedTaskIds: [], assignedCount: 0 },
    });
  });
});
