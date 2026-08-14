import { describe, expect, it } from "vitest";
import { buildBoardModel } from "../../src/tasks/boardModel.js";
import type { BoardSnapshot } from "@tachyon/engine/tasks/boardSnapshot.js";
import type { Task, TaskView } from "@tachyon/shared/tasks/types.js";
import { applyAwaitingHumanFilter, shouldShowAwaitingFilterButton } from "../../src/webview/board/interactions.js";

// t-2ab324 — App.tsx has no component-render harness in test/unit (see boardModel.test.ts's awaitingHuman
// suite), so this exercises the SAME pure functions App.tsx wires the toolbar button/board to:
// `applyAwaitingHumanFilter` (the toggle's scoping) and `shouldShowAwaitingFilterButton` (N=0 hides it).

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

describe("container-generated delegation behavior", () => {
  it("toggling the Awaiting-you toolbar filter scopes the board to only awaiting-human cards", () => {
    const flagged = task({
      id: "t-000001",
      status: "active",
      title: "pick an approach",
      awaitingHuman: { reason: "need a call on the migration approach", since: "2026-07-08T10:00:00.000Z", kind: "decision" },
    });
    const flaggedDropped = task({
      id: "t-000002",
      status: "dropped",
      title: "old idea, still flagged",
      awaitingHuman: { reason: "confirm before archiving", since: "2026-07-08T09:00:00.000Z", kind: "decision" },
    });
    const plainActive = task({ id: "t-000003", status: "active" });
    const plainTriaged = task({ id: "t-000004", status: "triaged" });
    const plainDropped = task({ id: "t-000005", status: "dropped" });

    const views: TaskView[] = [
      { task: flagged, attention: [{ code: "awaiting_human", message: flagged.awaitingHuman!.reason }] },
      { task: flaggedDropped, attention: [{ code: "awaiting_human", message: flaggedDropped.awaitingHuman!.reason }] },
      { task: plainActive },
      { task: plainTriaged },
      { task: plainDropped },
    ];
    const snapshot: BoardSnapshot = {
      views,
      allowedDropStatuses: { [flagged.id]: [], [flaggedDropped.id]: [], [plainActive.id]: [], [plainTriaged.id]: [], [plainDropped.id]: [] },
      chips: [],
    };
    const model = buildBoardModel({ snapshot });

    // toolbar: N = count of tasks with awaitingHuman, shown regardless of column/dropped bucket.
    expect(model.awaitingHuman?.count).toBe(2);
    expect(shouldShowAwaitingFilterButton(model.awaitingHuman?.count)).toBe(true);

    const totalCardsBefore = model.columns.reduce((n, c) => n + c.cards.length, 0) + model.dropped.cards.length;
    expect(totalCardsBefore).toBe(5);

    // OFF: the board (+ dropped bucket) is untouched — every card still shows, no strip artifact.
    const off = applyAwaitingHumanFilter(model.columns, model.dropped, false);
    expect(off.columns).toBe(model.columns);
    expect(off.dropped).toBe(model.dropped);

    // ON: scoped to exactly the awaiting-human set, across columns AND the dropped bucket.
    const on = applyAwaitingHumanFilter(model.columns, model.dropped, true);
    const visibleIdsOn = [...on.columns.flatMap((c) => c.cards.map((card) => card.id)), ...on.dropped.cards.map((card) => card.id)];
    expect(visibleIdsOn.sort()).toEqual(["t-000001", "t-000002"]);
    expect(on.columns.reduce((n, c) => n + c.count, 0)).toBe(1); // only flagged (active) lives in the always-on columns
    // Dropped toolbar count must use this scoped source, not the global pre-filter dropped total.
    expect(model.dropped.count).toBe(2);
    expect(on.dropped.count).toBe(1); // flaggedDropped lives in the dropped bucket

    // toggling back OFF restores the full board.
    const restored = applyAwaitingHumanFilter(model.columns, model.dropped, false);
    const visibleIdsRestored = [...restored.columns.flatMap((c) => c.cards.map((card) => card.id)), ...restored.dropped.cards.map((card) => card.id)];
    expect(visibleIdsRestored.sort()).toEqual(["t-000001", "t-000002", "t-000003", "t-000004", "t-000005"]);

    // N=0 hides the button.
    const noneFlagged: BoardSnapshot = { views: [{ task: plainActive }], allowedDropStatuses: { [plainActive.id]: [] }, chips: [] };
    const emptyModel = buildBoardModel({ snapshot: noneFlagged });
    expect(emptyModel.awaitingHuman).toBeUndefined();
    expect(shouldShowAwaitingFilterButton(emptyModel.awaitingHuman?.count)).toBe(false);
  });
});
