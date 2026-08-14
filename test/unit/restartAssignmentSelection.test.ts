import { describe, expect, it } from "vitest";
import {
  CURRENT_ASSIGNMENT_STATUS,
  selectAssignedWork,
  staleContractReferences,
  type BoardAssignmentRow,
} from "@tachyon/engine/agents/assignmentSelection.js";
import { renderSessionWorkRecord } from "@tachyon/engine/agents/sessionWorkRecord.js";

/**
 * t-9d250c — the two measured incidents, as fixtures.
 *
 * After `restart_agent(session:new)`:
 *  - `claude-opus5` reopened `t-2f6cdd`, already landed;
 *  - `claude-opus5-3` reopened the umbrella `t-067540`, already satisfied, instead of the phase tasks
 *    that were actually active.
 *
 * Both restarts replay the SPAWN brief verbatim — frozen at spawn time — beside a board record read
 * live. When the two disagree, the frozen one wins the agent's attention because it is phrased as a
 * contract while the record was a list of equals.
 *
 * Which assertions here are fail-before/pass-after, measured by restoring the previous rendering:
 * the ONE-current-task presentation and every stale-contract statement fail without the fix. The
 * status/assignee filters below do NOT — the old inline closure in `Workspace.ts` already filtered
 * `active && mine`, which is precisely why a landed task could only reach a restarted agent through
 * the frozen brief. They are pinned here because that rule moved out of an untested closure and is
 * now the thing the record's singular answer rests on.
 */
const row = (over: Partial<BoardAssignmentRow> & { id: string }): BoardAssignmentRow => ({
  title: `task ${over.id}`,
  status: "active",
  assignee: "claude-opus5-3",
  ...over,
});

describe("incident 1 — a landed task must not come back as the contract (guards; the fix is the naming below)", () => {
  it("never selects a landed task, whatever else the board holds", () => {
    // claude-opus5's board at restart: the landed one it reopened, plus the work actually waiting.
    const board = [
      row({ id: "t-2f6cdd", status: "landed", assignee: "claude-opus5", title: "Control task-detail shell handshake" }),
      row({ id: "t-05097f", status: "active", assignee: "claude-opus5", title: "autostart race" }),
    ];
    const selection = selectAssignedWork(board, "claude-opus5");

    expect(selection.current?.id).toBe("t-05097f");
    expect([selection.current?.id, ...selection.queue.map((task) => task.id)]).not.toContain("t-2f6cdd");
  });

  it("refuses every terminal and pre-active status, not just landed", () => {
    const board = ["landed", "done", "dropped", "inbox", "triaged"].map((status, index) =>
      row({ id: `t-00000${index}`, status, assignee: "claude-opus5" }));
    const selection = selectAssignedWork(board, "claude-opus5");

    expect(selection.current).toBeUndefined();
    expect(selection.queue).toEqual([]);
    // the one status that may ever be a contract, stated once and shared with the selector
    expect(CURRENT_ASSIGNMENT_STATUS).toBe("active");
  });

  it("never selects a task that names a DIFFERENT agent", () => {
    const board = [row({ id: "t-111111", assignee: "codex-canonico" }), row({ id: "t-222222", assignee: "claude-opus5-3" })];
    expect(selectAssignedWork(board, "claude-opus5-3").current?.id).toBe("t-222222");
    expect(selectAssignedWork(board, "someone-else").current).toBeUndefined();
  });

  it("accepts a row that names nobody — a pre-scoped resolver must not empty the record", () => {
    // `assignedWork(name)` is scoped by its own signature, and production already filters by
    // assignee. A row without the field is pre-scoped, not unowned; dropping it would make a restart
    // say "nothing is assigned" while the task sits on the board — quietly, which is worse.
    const board = [{ id: "t-333333", title: "pre-scoped row", status: "active" }];
    expect(selectAssignedWork(board, "claude-opus5-3").current?.id).toBe("t-333333");
  });
});

describe("incident 2 — the satisfied umbrella, and the phases that were actually active", () => {
  /** The board as it stood when claude-opus5-3 was restarted onto the wrong task. */
  const board = (umbrellaStatus: string): BoardAssignmentRow[] => [
    row({ id: "t-067540", status: umbrellaStatus, priority: 1, title: "Sidebar: card templates (umbrella)", updatedAt: "2026-07-27T21:11:00.000Z" }),
    row({ id: "t-7f454e", status: "active", priority: 1, title: "SDD 479 phase 2", updatedAt: "2026-07-27T21:38:00.000Z" }),
    row({ id: "t-6a251c", status: "active", priority: 2, title: "SDD 479 phase 3", updatedAt: "2026-07-27T22:08:00.000Z" }),
  ];

  it("selects a live phase task once the umbrella is landed, not the umbrella", () => {
    const selection = selectAssignedWork(board("landed"), "claude-opus5-3");
    expect(selection.current?.id).toBe("t-7f454e");
    expect(selection.queue.map((task) => task.id)).toEqual(["t-6a251c"]);
  });

  it("presents ONE current task even when several are active — the choice is not the agent's", () => {
    // The umbrella still says `active` here, which is the state that actually shipped: the status was
    // stale bookkeeping. Selection cannot know it is satisfied, so what it must not do is hand the
    // agent three equals and let the frozen brief break the tie.
    const selection = selectAssignedWork(board("active"), "claude-opus5-3");
    expect(selection.queue).toHaveLength(2);

    const rendered = renderSessionWorkRecord({ isolation: { kind: "shared", cwd: "/repo" }, assignment: selection });
    expect(rendered).toContain("Your current task, read from the board at restart");
    expect(rendered).toContain("NOT your current task");
  });

  it("names the umbrella as finished when the frozen brief still carries it", () => {
    // This is what closes the incident even with a perfect selector: the brief being replayed says
    // "Continue the now-ratified t-067540", and the record now answers that in the same document.
    const selection = selectAssignedWork(board("landed"), "claude-opus5-3");
    const stale = staleContractReferences(
      "TASK: Continue the now-ratified t-067540 / SDD 479 and prepare implementation.",
      selection,
      (id) => (id === "t-067540" ? "landed" : undefined),
    );

    expect(stale).toEqual([{ id: "t-067540", status: "landed", closed: true }]);
    const rendered = renderSessionWorkRecord({
      isolation: { kind: "shared", cwd: "/repo" },
      assignment: selection,
      staleContractReferences: stale,
    });
    expect(rendered).toContain("Do not reopen t-067540");
  });
});

describe("the order is total, so two restarts of one board agree", () => {
  it("prefers the most urgent priority, then rank, then the most recently touched", () => {
    const board = [
      row({ id: "t-aaaaaa", priority: 2, updatedAt: "2026-07-27T10:00:00.000Z" }),
      row({ id: "t-bbbbbb", priority: 1, rank: "m", updatedAt: "2026-07-27T09:00:00.000Z" }),
      row({ id: "t-cccccc", priority: 1, rank: "a", updatedAt: "2026-07-27T08:00:00.000Z" }),
    ];
    expect(selectAssignedWork(board, "claude-opus5-3").current?.id).toBe("t-cccccc");
    expect(selectAssignedWork(board.slice().reverse(), "claude-opus5-3").current?.id).toBe("t-cccccc");
  });

  it("sorts an unset priority after every set one", () => {
    const board = [row({ id: "t-aaaaaa" }), row({ id: "t-bbbbbb", priority: 3 })];
    expect(selectAssignedWork(board, "claude-opus5-3").current?.id).toBe("t-bbbbbb");
  });

  it("breaks a full tie by id rather than by store order", () => {
    const board = [row({ id: "t-bbbbbb", priority: 1 }), row({ id: "t-aaaaaa", priority: 1 })];
    expect(selectAssignedWork(board, "claude-opus5-3").current?.id).toBe("t-aaaaaa");
    expect(selectAssignedWork(board.slice().reverse(), "claude-opus5-3").current?.id).toBe("t-aaaaaa");
  });

  it("an empty board is an answer, not a missing value", () => {
    expect(selectAssignedWork([], "claude-opus5-3")).toEqual({ queue: [] });
  });
});

describe("stale-reference reporting states facts and nothing else", () => {
  const selection = selectAssignedWork([row({ id: "t-7f454e" })], "claude-opus5-3");

  it("says nothing about an id the store does not know", () => {
    // Another workspace's id, or a typo: "I cannot find it" is not evidence that the work is over.
    expect(staleContractReferences("see t-999999 for context", selection, () => undefined)).toEqual([]);
  });

  it("says nothing about the task that IS current", () => {
    expect(staleContractReferences("TASK: finish t-7f454e", selection, () => "active")).toEqual([]);
  });

  it("says nothing about a task still queued for this agent", () => {
    const queued = selectAssignedWork([row({ id: "t-7f454e", priority: 1 }), row({ id: "t-6a251c", priority: 2 })], "claude-opus5-3");
    expect(staleContractReferences("also see t-6a251c", queued, () => "active")).toEqual([]);
  });

  it("reports each id once, however often the brief repeats it", () => {
    const stale = staleContractReferences("t-067540 … t-067540 … T-067540", selection, () => "done");
    expect(stale).toEqual([{ id: "t-067540", status: "done", closed: true }]);
  });

  it("has nothing to report when no brief is replayed", () => {
    expect(staleContractReferences(undefined, selection, () => "landed")).toEqual([]);
  });
});
