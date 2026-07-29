import { describe, expect, it } from "vitest";
import { isAgentInputCommandV1 } from "../../src/runtime-api/agentInputCommands.js";
import {
  parseActivityContextViewV1,
  projectActivityContext,
} from "../../src/runtime-api/activityProjection.js";

describe("Activity Runtime API", () => {
  it("projects one bounded context with live share targets and attention", async () => {
    const source = {
      ledger: {
        get: () => undefined,
        all: () => [] as Array<[string, never]>,
      },
      manager: {
        transcriptPathOf: async () => undefined,
        list: async () => [
          row("codex", { attention: undefined }),
          row("reviewer", { running: true, lifetime: "temporary", resumePolicy: "collected" }),
          row("terminal", { running: true, kind: "terminal" }),
          row("stopped"),
        ],
      },
      attentionOf: (agent: string) => agent === "codex" ? { state: "working" as const } : undefined,
    };

    await expect(projectActivityContext(source, "codex")).resolves.toEqual({
      schemaVersion: 1,
      agent: "codex",
      sharedCwd: false,
      attention: "working",
      targets: {
        total: 1,
        truncated: false,
        items: [{ name: "reviewer", lifetime: "temporary" }],
      },
    });
  });

  it("rejects contradictory or redirected context projections", () => {
    const view = {
      schemaVersion: 1 as const,
      context: {
        schemaVersion: 1 as const,
        agent: "codex",
        sharedCwd: false,
        attention: null,
        targets: { total: 1, truncated: false, items: [{ name: "reviewer", lifetime: "saved" }] },
      },
    };
    expect(parseActivityContextViewV1(view)).toEqual(view);
    expect(() => parseActivityContextViewV1({
      ...view,
      context: { ...view.context, targets: { ...view.context.targets, total: 2 } },
    })).toThrow(/bounds contradict/);
    expect(() => parseActivityContextViewV1({
      ...view,
      context: { ...view.context, targets: { total: 1, truncated: false, items: [{ name: "codex", lifetime: "saved" }] } },
    })).toThrow(/include the source agent/);
  });

  it("accepts only exact, bounded managed-agent input", () => {
    expect(isAgentInputCommandV1({ agent: "reviewer", text: "context", submit: false })).toBe(true);
    expect(isAgentInputCommandV1({ agent: "reviewer", text: "context", submit: false, extra: true })).toBe(false);
    expect(isAgentInputCommandV1({ agent: "../escape", text: "context", submit: false })).toBe(false);
    expect(isAgentInputCommandV1({ agent: "reviewer", text: "contains\0nul", submit: false })).toBe(false);
    expect(isAgentInputCommandV1({ agent: "reviewer", text: "x".repeat(48 * 1024 + 1), submit: false })).toBe(false);
  });
});

function row(
  name: string,
  overrides: Partial<{
    running: boolean;
    lifetime: "saved" | "temporary";
    resumePolicy: "restartable" | "collected";
    kind: "agent" | "terminal";
    attention: undefined;
  }> = {},
) {
  return {
    name,
    session: `tachyon-${name}`,
    running: false,
    stopping: false,
    stopFailed: false,
    lifetime: "saved" as const,
    resumePolicy: "restartable" as const,
    dead: false,
    crashed: false,
    kind: "agent" as const,
    ...overrides,
  };
}
