import { describe, expect, it } from "vitest";
import { agentFilterOptions, buildBoardModel, colorTokenFor, matchesBoardSearch, HUMAN_COLOR_VAR } from "../../src/tasks/boardModel.js";
import type { BoardChip, BoardSnapshot } from "../../src/tasks/boardSnapshot.js";
import type { Task, TaskView } from "../../src/tasks/types.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "t-000001",
    title: "task",
    status: "inbox",
    author: "human",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

function snapshotFor(tasks: Task[], chips: BoardChip[] = []): BoardSnapshot {
  const views: TaskView[] = tasks.map((t) => ({ task: t }));
  const allowedDropStatuses: Record<string, Task["status"][]> = {};
  for (const t of tasks) allowedDropStatuses[t.id] = [];
  return { views, allowedDropStatuses, chips };
}

describe("buildBoardModel", () => {
  it("splits into the 4 always-on columns + a separate dropped bucket, with counts", () => {
    const tasks = [
      task({ id: "t-000001", status: "inbox" }),
      task({ id: "t-000002", status: "triaged" }),
      task({ id: "t-000003", status: "active", assignee: "codex" }),
      task({ id: "t-000004", status: "done" }),
      task({ id: "t-000005", status: "dropped" }),
    ];
    const model = buildBoardModel({ snapshot: snapshotFor(tasks) });
    expect(model.columns.map((c) => c.status)).toEqual(["inbox", "triaged", "active", "done"]);
    expect(model.columns.map((c) => c.count)).toEqual([1, 1, 1, 1]);
    expect(model.dropped.count).toBe(1);
    expect(model.dropped.cards[0].id).toBe("t-000005");
    // dropped never appears among the 4 always-on columns
    expect(model.columns.some((c) => c.cards.some((card) => card.id === "t-000005"))).toBe(false);
  });

  it("orders cards within a column by the next_task comparator (priority → rank → createdAt → id)", () => {
    const tasks = [
      task({ id: "t-000003", status: "triaged", priority: 1, createdAt: "2026-07-01T00:00:00.000Z" }),
      task({ id: "t-000002", status: "triaged", priority: 1, rank: "a", createdAt: "2026-07-03T00:00:00.000Z" }),
      task({ id: "t-000001", status: "triaged", priority: 0, createdAt: "2026-07-01T00:00:00.000Z" }),
    ];
    const model = buildBoardModel({ snapshot: snapshotFor(tasks) });
    const triaged = model.columns.find((c) => c.status === "triaged")!;
    expect(triaged.cards.map((c) => c.id)).toEqual(["t-000001", "t-000002", "t-000003"]);
  });

  it("card anatomy: priority accent, kind/assignee color tokens, SDD chip, attention badges", () => {
    const t = task({
      id: "t-000001",
      status: "active",
      priority: 0,
      kind: "bug",
      assignee: "codex",
      artifact_refs: [{ type: "sdd", ref: "325-task-queue-entity" }],
    });
    const views: TaskView[] = [{
      task: t,
      derived: { sdd: { type: "sdd", ref: "325-task-queue-entity", status: "in-progress" } },
      attention: [{ code: "ready_to_close", message: "close it" }],
    }];
    const snapshot: BoardSnapshot = { views, allowedDropStatuses: { [t.id]: ["done", "triaged", "dropped"] }, chips: [] };
    const model = buildBoardModel({ snapshot });
    const card = model.columns.find((c) => c.status === "active")!.cards[0];
    expect(card.priorityAccent).toBe("err");
    expect(card.kind).toBe("bug");
    expect(card.kindColorVar).toBe(colorTokenFor("bug"));
    expect(card.assignee).toBe("codex");
    expect(card.assigneeColorVar).toBe(colorTokenFor("codex"));
    expect(card.sddStatus).toBe("in-progress");
    expect(card.attention).toEqual([{ code: "ready_to_close", message: "close it" }]);
  });

  it("card.attachmentCount comes from snapshot.attachmentCounts (sparse — absent when there are none)", () => {
    const withPic = task({ id: "t-000001", status: "active" });
    const plain = task({ id: "t-000002", status: "active" });
    const snapshot = snapshotFor([withPic, plain]);
    snapshot.attachmentCounts = { [withPic.id]: 2 };
    const model = buildBoardModel({ snapshot });
    const cards = model.columns.find((c) => c.status === "active")!.cards;
    expect(cards.find((c) => c.id === withPic.id)?.attachmentCount).toBe(2);
    expect(cards.find((c) => c.id === plain.id)?.attachmentCount).toBeUndefined();
  });

  it("card.journalCount comes from TaskSummary metadata without any entry text", () => {
    const withNotes = task({ id: "t-000001", status: "active" });
    const plain = task({ id: "t-000002", status: "active" });
    const views: TaskView[] = [{ task: withNotes, journalCount: 2 }, { task: plain, journalCount: 0 }];
    const model = buildBoardModel({ snapshot: { views, allowedDropStatuses: {}, chips: [] } });
    const cards = model.columns.find((c) => c.status === "active")!.cards;
    expect(cards.find((c) => c.id === withNotes.id)?.journalCount).toBe(2);
    expect(cards.find((c) => c.id === plain.id)?.journalCount).toBeUndefined();
    expect(JSON.stringify(model)).not.toContain("journal text");
  });

  it("colorTokenFor: human is reserved, unknown names hash deterministically and never collide with human", () => {
    expect(colorTokenFor("human")).toBe(HUMAN_COLOR_VAR);
    expect(colorTokenFor("claude")).toBe(colorTokenFor("claude"));
    expect(colorTokenFor("some-ad-hoc-runner")).not.toBe(HUMAN_COLOR_VAR);
    expect(colorTokenFor("some-ad-hoc-runner")).not.toBe("");
  });

  it("spotlight: selects the chip's next_task card and dims cards not owned/claimable by that agent", () => {
    const mine = task({ id: "t-000001", status: "triaged", assignee: "codex" });
    const claimable = task({ id: "t-000002", status: "triaged" });
    const elsewhere = task({ id: "t-000003", status: "active", assignee: "claude" });
    const chips: BoardChip[] = [{ agent: "codex", source: "declared", next: { task: mine } }];
    const model = buildBoardModel({ snapshot: snapshotFor([mine, claimable, elsewhere], chips), selectedChip: "codex" });
    expect(model.spotlight).toEqual({ agent: "codex", taskId: "t-000001" });
    const byId = (id: string) => model.columns.flatMap((c) => c.cards).find((c) => c.id === id)!;
    expect(byId("t-000001").isSpotlight).toBe(true);
    expect(byId("t-000001").isDimmed).toBe(false);
    expect(byId("t-000002").isDimmed).toBe(false); // unassigned + triaged = claimable
    expect(byId("t-000003").isDimmed).toBe(true); // assigned elsewhere
  });

  it("spotlight: an empty next_task result surfaces the structured reason instead of a task id", () => {
    const chips: BoardChip[] = [{ agent: "codex", source: "declared", next: { empty: true, reason: "no-tasks" } }];
    const model = buildBoardModel({ snapshot: snapshotFor([], chips), selectedChip: "codex" });
    expect(model.spotlight).toEqual({ agent: "codex", emptyReason: "no-tasks" });
  });

  it("no chip selected → no spotlight, nothing dimmed", () => {
    const t = task({ id: "t-000001", status: "triaged" });
    const model = buildBoardModel({ snapshot: snapshotFor([t]) });
    expect(model.spotlight).toBeUndefined();
    expect(model.columns.flatMap((c) => c.cards).every((c) => !c.isDimmed)).toBe(true);
  });

  it("chips: declared agents + human are bounded/inline, ad-hoc assignees go to the overflow set — dogfood round 1 (#5)", () => {
    const chips: BoardChip[] = [
      { agent: "codex", source: "declared", next: { empty: true, reason: "no-tasks" } },
      { agent: "human", source: "human", next: { empty: true, reason: "no-tasks" } },
      { agent: "some-random-runner", source: "assignee", next: { empty: true, reason: "no-tasks" } },
      { agent: "another-ad-hoc", source: "assignee", next: { empty: true, reason: "no-tasks" } },
    ];
    const model = buildBoardModel({ snapshot: snapshotFor([], chips) });
    expect(model.chips.map((c) => c.agent)).toEqual(["codex", "human"]);
    expect(model.chipOverflow.map((c) => c.agent)).toEqual(["some-random-runner", "another-ad-hoc"]);
  });

  it("chips: no ad-hoc assignees on the board → an empty overflow set, never crashes on the split", () => {
    const chips: BoardChip[] = [{ agent: "codex", source: "declared", next: { empty: true, reason: "no-tasks" } }];
    const model = buildBoardModel({ snapshot: snapshotFor([], chips) });
    expect(model.chips.map((c) => c.agent)).toEqual(["codex"]);
    expect(model.chipOverflow).toEqual([]);
  });

  it("agentFilterOptions: dogfood round 2 (#5) — one flat, ordered list for the agent filter dropdown " +
    "(declared/human first in their original order, then ad-hoc assignees alpha-sorted)", () => {
    const chips: BoardChip[] = [
      { agent: "codex", source: "declared", next: { empty: true, reason: "no-tasks" } },
      { agent: "human", source: "human", next: { empty: true, reason: "no-tasks" } },
      { agent: "zeta-runner", source: "assignee", next: { empty: true, reason: "no-tasks" } },
      { agent: "alpha-runner", source: "assignee", next: { empty: true, reason: "no-tasks" } },
    ];
    const model = buildBoardModel({ snapshot: snapshotFor([], chips) });
    expect(agentFilterOptions(model).map((c) => c.agent)).toEqual(["codex", "human", "alpha-runner", "zeta-runner"]);
  });

  it("agentFilterOptions: no ad-hoc assignees → just the bounded set, never crashes on an empty overflow", () => {
    const chips: BoardChip[] = [{ agent: "codex", source: "declared", next: { empty: true, reason: "no-tasks" } }];
    const model = buildBoardModel({ snapshot: snapshotFor([], chips) });
    expect(agentFilterOptions(model).map((c) => c.agent)).toEqual(["codex"]);
  });

  it("t-5ea4c7: matchesBoardSearch — case-insensitive substring across title/id/kind/assignee/body; empty query matches everything", () => {
    const t = task({
      id: "t-abc123",
      title: "Fix the flaky retry loop",
      kind: "bug",
      assignee: "codex",
      body: "Root cause is a missing debounce.",
    });
    expect(matchesBoardSearch(t, undefined)).toBe(true);
    expect(matchesBoardSearch(t, "")).toBe(true);
    expect(matchesBoardSearch(t, "   ")).toBe(true);
    expect(matchesBoardSearch(t, "FLAKY")).toBe(true); // title, case-insensitive
    expect(matchesBoardSearch(t, "abc123")).toBe(true); // id
    expect(matchesBoardSearch(t, "bug")).toBe(true); // kind
    expect(matchesBoardSearch(t, "codex")).toBe(true); // assignee
    expect(matchesBoardSearch(t, "debounce")).toBe(true); // body
    expect(matchesBoardSearch(t, "nonexistent-term")).toBe(false);
  });

  it("t-5ea4c7: matchesBoardSearch never throws on a task with no kind/assignee/body", () => {
    const bare = task({ id: "t-000001", title: "bare task" });
    expect(matchesBoardSearch(bare, "bare")).toBe(true);
    expect(matchesBoardSearch(bare, "nope")).toBe(false);
  });

  it("t-5ea4c7: searchQuery HIDES non-matching cards (unlike the agent chip, which only dims) and updates counts", () => {
    const tasks = [
      task({ id: "t-000001", status: "triaged", title: "Bridge reload bug" }),
      task({ id: "t-000002", status: "triaged", title: "Unrelated card" }),
      task({ id: "t-000003", status: "dropped", title: "Bridge dropped card" }),
    ];
    const model = buildBoardModel({ snapshot: snapshotFor(tasks), searchQuery: "bridge" });
    const triaged = model.columns.find((c) => c.status === "triaged")!;
    expect(triaged.cards.map((c) => c.id)).toEqual(["t-000001"]);
    expect(triaged.count).toBe(1);
    expect(model.dropped.cards.map((c) => c.id)).toEqual(["t-000003"]);
    expect(model.dropped.count).toBe(1);
  });

  it("t-5ea4c7: an empty/whitespace searchQuery is a no-op filter (every card stays)", () => {
    const tasks = [task({ id: "t-000001", status: "triaged" }), task({ id: "t-000002", status: "triaged" })];
    const model = buildBoardModel({ snapshot: snapshotFor(tasks), searchQuery: "   " });
    expect(model.columns.find((c) => c.status === "triaged")!.cards.map((c) => c.id)).toEqual(["t-000001", "t-000002"]);
  });

  it("scale envelope: 500 tasks stay keyed/ordered, and a single-task mutation leaves the rest untouched", () => {
    const statuses: Task["status"][] = ["inbox", "triaged", "active", "done", "dropped"];
    const tasks: Task[] = Array.from({ length: 500 }, (_, i) => task({
      id: `t-${i.toString(16).padStart(6, "0")}`,
      status: statuses[i % statuses.length],
      priority: (i % 4) as Task["priority"],
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));

    const start = Date.now();
    const before = buildBoardModel({ snapshot: snapshotFor(tasks) });
    const mid = Date.now();
    expect(mid - start).toBeLessThan(2000); // loose, CI-tolerant — asserting it scales, not a tight budget

    const mutatedId = tasks[7].id; // an "active" task (7 % 5 === 2)
    const mutatedTasks = tasks.map((t) => (t.id === mutatedId ? { ...t, assignee: "codex" } : t));
    const after = buildBoardModel({ snapshot: snapshotFor(mutatedTasks) });

    for (const status of ["inbox", "triaged", "active", "done"] as const) {
      const beforeIds = before.columns.find((c) => c.status === status)!.cards.map((c) => c.id);
      const afterIds = after.columns.find((c) => c.status === status)!.cards.map((c) => c.id);
      expect(afterIds).toEqual(beforeIds); // order/identity of every OTHER card is untouched
    }
    const mutatedCard = after.columns.find((c) => c.status === "active")!.cards.find((c) => c.id === mutatedId)!;
    expect(mutatedCard.assignee).toBe("codex");
  });
});
