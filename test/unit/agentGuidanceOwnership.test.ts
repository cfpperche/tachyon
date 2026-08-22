import { describe, expect, it } from "vitest";
import { renderPrimer, type PrimerInput } from "@tachyon/engine/agents/primer.js";
import { renderSessionWorkRecord, type SessionWorkRecord } from "@tachyon/engine/agents/sessionWorkRecord.js";

/**
 * t-a1ee7e — the completion of t-486f43's boundary, in the direction it never reached.
 *
 * `projectGuidanceOwnership.test.ts` classifies every immune line of the PRIMER as a product fact.
 * It never covered the WORK ON RECORD, and that is where the orchestration model actually lived:
 * "Wait for an explicit assignment" and "Do not adopt work by scanning the board" imposed a push
 * dispatch model on every agent of every project, inside a document the primer declared the project
 * could not override. A workspace running a pull model was contradicted with nowhere to answer.
 *
 * The methods did not move to a new setting — they left the product. Tachyon already has two places
 * where a project says how it works, and both predate this task: an agent's PERSISTENT INSTRUCTIONS
 * (its profile's instructions.md, or the spawn brief for a Temporary) and the project's own guidance
 * documents (spec 383). A third mechanism would only have split the same answer across two files.
 *
 * So the guard is simply: nothing an agent is handed states a working method at all.
 */

const TASK = { id: "t-000001", title: "a task", status: "active" as const };

const RECORD_SHAPES: Array<{ label: string; record: SessionWorkRecord }> = [
  { label: "worktree, nothing assigned", record: { launch: "spawn", isolation: { kind: "worktree", path: "/wt", branch: "b" }, assignment: { queue: [] } } },
  { label: "shared checkout, nothing assigned", record: { launch: "spawn", isolation: { kind: "shared", cwd: "/ws" }, assignment: { queue: [] } } },
  {
    label: "assigned with a queue behind it",
    record: {
      launch: "restart",
      isolation: { kind: "shared", cwd: "/ws" },
      assignment: { current: TASK, queue: [{ id: "t-000002", title: "next", status: "active" }] },
    },
  },
  { label: "nothing assigned but a delegation brief present", record: { launch: "spawn", isolation: { kind: "shared", cwd: "/ws" }, assignment: { queue: [] }, hasTaskBrief: true } },
];

const PRIMER_SHAPES: Array<{ label: string; input: PrimerInput }> = [
  { label: "declared agent", input: { agentName: "solo" } },
  { label: "delegated child", input: { agentName: "child", delegator: "coordinator" } },
];

function everythingAnAgentIsHanded(): string {
  return [
    ...RECORD_SHAPES.map(({ record }) => renderSessionWorkRecord(record)),
    ...PRIMER_SHAPES.map(({ input }) => {
      const rendered = renderPrimer(input);
      return `${rendered.primer}\n${rendered.beforeFinishing}`;
    }),
  ].join("\n");
}

describe("t-a1ee7e: orchestration is the user's — the product states no working method", () => {
  it("states none of the methods it used to impose", () => {
    // Measured verbatim on 2026-08-22, before the removal. Each one is a defensible policy and a
    // different project would want a different answer, which is exactly why none of them is the
    // product's to state.
    const IMPOSED_BEFORE = [
      "Wait for an explicit assignment",
      "Do not adopt work by scanning the board",
      "Finish or hand back the one above",
      "report it to your spawner and do not pick one",
      "Report it to your spawner and do not pick one",
      "Make every change here",
      "create one before you change tracked files",
      "summary: status + commit/tree",
      // and the immunity claim that made all of the above unanswerable
      "cannot override either contract or protocol",
    ];
    const handed = everythingAnAgentIsHanded();
    for (const method of IMPOSED_BEFORE) expect(handed, `the product still states: ${method}`).not.toContain(method);
  });

  it("names where a working method actually comes from", () => {
    const { primer } = renderPrimer({ agentName: "solo" });
    expect(primer).toMatch(/is not Tachyon's to say/);
    expect(primer).toMatch(/persistent instructions/);
  });

  it("the WORK ON RECORD states facts about THIS session and nothing else", () => {
    // Every line is a measurement of the session, the checkout or the board. A line that is neither
    // is a working method born immune — the t-486f43 defect, which lived here unclassified.
    const RECORD_FACT = [
      /^── SESSION (SPAWN|RESTART|RETASK): WORK ON RECORD ──$/,
      /^── END SESSION (SPAWN|RESTART|RETASK) ──$/,
      /^This session is NEW\./,
      /^This session was restarted with a NEW conversation\./,
      /^This live session was retasked WITHOUT restarting it\./,
      /^Checkout: separate git worktree /,
      /^Checkout: shared — /,
      /^No worktree or branch was recorded for you, so nothing here authorizes committing to the trunk\.$/,
      /^Assigned work on record: none\.$/,
      /^Execute the delegation brief above as delegated work\. It does not create or assign a board task\.$/,
      /^Your current task, read from the board at /,
      /^Also assigned to you and still active \(\d+\) — NOT your current task\.$/,
      /^- t-[0-9a-f]{6} — /,
    ];
    for (const { label, record } of RECORD_SHAPES) {
      for (const line of renderSessionWorkRecord(record).split("\n").filter((l) => l.trim())) {
        expect(
          RECORD_FACT.some((fact) => fact.test(line)),
          `${label}: this line is not a classified fact about the session — if it is a working method, it belongs in an agent's persistent instructions, not in the product:\n${line}`,
        ).toBe(true);
      }
    }
  });

  it("the workspace has no third place to configure agent methods", () => {
    // A settings key for this existed for one release (0.93.31) and was redundant: persistent
    // instructions are per agent and already reach every spawn shape, and project guidance is per
    // project. Two answers to one question is how they drift apart.
    expect(() => require.resolve("@tachyon/engine/agents/agentGuidance.js")).toThrow();
  });
});
