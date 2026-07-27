import { describe, expect, it } from "vitest";
import type { AgentPromptManifest } from "../../src/agents/promptLayers.js";
import {
  MAX_STARTUP_BRIEF_INVENTORY_BYTES,
  MAX_STARTUP_BRIEF_SUMMARY_BYTES,
  renderStartupBriefInventory,
  renderStartupBriefSummary,
  type StartupBriefManifest,
} from "../../src/agents/startupBrief.js";

const emptyPrompt: AgentPromptManifest = {
  soul: false,
  role: false,
  persistentInstructions: false,
  bridgeGuidance: false,
  task: { kind: "absent" },
};

function manifest(overrides: Partial<StartupBriefManifest> = {}): StartupBriefManifest {
  return { projectGuidanceSources: 0, prompt: emptyPrompt, ...overrides };
}

describe("startup brief manifest rendering", () => {
  it("renders the guidance-only launch as context with no task objective", () => {
    const value = manifest({ projectGuidanceSources: 2 });

    expect(renderStartupBriefSummary(value)).toBe(
      "Contains: project guidance (2 sources); soul (absent); role (absent); persistent instructions (absent); Bridge guidance (absent); task contract (absent).\n" +
      "Task objective: absent — awaiting assignment.",
    );
    expect(renderStartupBriefInventory(value)).toBe(
      "── STARTUP BRIEF CONTENTS ──\n" +
      "Project guidance: 2 sources\n" +
      "Soul: absent\n" +
      "Role: absent\n" +
      "Persistent instructions: absent\n" +
      "Bridge guidance: absent\n" +
      "Task: absent — awaiting assignment\n" +
      "── END STARTUP BRIEF CONTENTS ──",
    );
  });

  it.each([
    ["deliverable", "DELIVERABLE"],
    ["done_when", "DONE_WHEN"],
  ] as const)("distinguishes a structured %s contract", (completion, display) => {
    const value = manifest({
      projectGuidanceSources: 1,
      prompt: { ...emptyPrompt, role: true, task: { kind: "contract", completion } },
    });

    expect(renderStartupBriefSummary(value)).toContain(`task contract (${display})`);
    expect(renderStartupBriefSummary(value)).not.toContain("Task objective: absent");
    expect(renderStartupBriefInventory(value)).toContain(`Task: contract (${display})`);
  });

  it("distinguishes an unstructured execution brief from a structured task contract", () => {
    const value = manifest({ prompt: { ...emptyPrompt, task: { kind: "brief" } } });

    expect(renderStartupBriefSummary(value)).toContain("task brief (present); task contract (absent)");
    expect(renderStartupBriefInventory(value)).toContain("Task: unstructured brief");
  });

  it("t-e3aaae: names the assigned task on record instead of reporting an absent objective", () => {
    const value = manifest({
      prompt: {
        ...emptyPrompt,
        sessionRecord: { isolation: "worktree", assignedTaskIds: ["t-5bfb72"], assignedCount: 1 },
      },
    });

    expect(renderStartupBriefSummary(value)).toContain("work on record (worktree; t-5bfb72)");
    expect(renderStartupBriefSummary(value)).not.toContain("Task objective: absent");
    expect(renderStartupBriefInventory(value)).toContain("Work on record: isolation worktree; assigned t-5bfb72");
  });

  it("t-e3aaae: a restart with nothing assigned still reports an absent objective", () => {
    const value = manifest({
      prompt: { ...emptyPrompt, sessionRecord: { isolation: "shared", assignedTaskIds: [], assignedCount: 0 } },
    });

    expect(renderStartupBriefSummary(value)).toContain("work on record (shared; no assigned work)");
    expect(renderStartupBriefSummary(value)).toContain("Task objective: absent — awaiting assignment.");
    expect(renderStartupBriefInventory(value)).toContain("Work on record: isolation shared; assigned no assigned work");
  });

  it("t-e3aaae: collapses a long assignment list to ids plus a truthful remainder", () => {
    const value = manifest({
      prompt: {
        ...emptyPrompt,
        sessionRecord: { isolation: "worktree", assignedTaskIds: ["t-000001", "t-000002", "t-000003"], assignedCount: 7 },
      },
    });

    expect(renderStartupBriefSummary(value)).toContain("t-000001, t-000002, t-000003, +4 more");
  });

  it("keeps every valid rendering below a fixed byte budget", () => {
    const maximal = manifest({
      projectGuidanceSources: 8,
      prompt: {
        soul: true,
        role: true,
        persistentInstructions: true,
        bridgeGuidance: true,
        task: { kind: "contract", completion: "done_when" },
        sessionRecord: { isolation: "worktree", assignedTaskIds: ["t-000001", "t-000002", "t-000003"], assignedCount: 99 },
      },
    });

    expect(Buffer.byteLength(renderStartupBriefSummary(maximal), "utf8")).toBeLessThanOrEqual(MAX_STARTUP_BRIEF_SUMMARY_BYTES);
    expect(Buffer.byteLength(renderStartupBriefInventory(maximal), "utf8")).toBeLessThanOrEqual(MAX_STARTUP_BRIEF_INVENTORY_BYTES);
  });

  it.each([-1, 1.5, 9, Number.NaN])("rejects an invalid project-guidance source count: %s", (projectGuidanceSources) => {
    expect(() => renderStartupBriefSummary(manifest({ projectGuidanceSources }))).toThrow(/project guidance source count/);
    expect(() => renderStartupBriefInventory(manifest({ projectGuidanceSources }))).toThrow(/project guidance source count/);
  });
});
