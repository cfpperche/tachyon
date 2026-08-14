import { describe, expect, it } from "vitest";
import { reduceDetailStale, INITIAL_STALE_STATE, selectedReviewablePrototype, type DetailStaleState } from "../../packages/webview-ui/src/webview/task-detail/interactions.js";
import type { TaskPrototypeListVM, TaskPrototypeVM } from "../../packages/webview-ui/src/webview/task-prototype/types.js";

const STALE = "precondition-failed: updatedAt did not match";

function submitPriority(state: DetailStaleState): DetailStaleState {
  return reduceDetailStale(state, { type: "submit", field: "priority" });
}
function submitAssignee(state: DetailStaleState): DetailStaleState {
  return reduceDetailStale(state, { type: "submit", field: "assignee" });
}

describe("reduceDetailStale", () => {
  it("a CAS failure flags only the field that was actually in flight — dogfood round 1 (#2)", () => {
    const afterSubmit = submitPriority(INITIAL_STALE_STATE);
    const afterError = reduceDetailStale(afterSubmit, { type: "error", message: STALE });
    expect(afterError).toMatchObject({ priorityStale: true, assigneeStale: false, pendingField: null });
  });

  it("never flags the unrelated field", () => {
    const afterSubmit = submitAssignee(INITIAL_STALE_STATE);
    const afterError = reduceDetailStale(afterSubmit, { type: "error", message: STALE });
    expect(afterError).toMatchObject({ priorityStale: false, assigneeStale: true, pendingField: null });
  });

  it("does nothing when no field was pending (nothing submitted, or it already resolved)", () => {
    const afterError = reduceDetailStale(INITIAL_STALE_STATE, { type: "error", message: STALE });
    expect(afterError).toMatchObject({ priorityStale: false, assigneeStale: false });
  });

  it("does nothing for a non-stale error, but still clears the pending marker", () => {
    const afterSubmit = submitPriority(INITIAL_STALE_STATE);
    const afterError = reduceDetailStale(afterSubmit, { type: "error", message: "active tasks require assignee" });
    expect(afterError).toMatchObject({ priorityStale: false, assigneeStale: false, pendingField: null });
  });

  it("two independent CAS failures can leave both fields stale at once", () => {
    let state = reduceDetailStale(submitPriority(INITIAL_STALE_STATE), { type: "error", message: STALE });
    state = reduceDetailStale(submitAssignee(state), { type: "error", message: STALE });
    expect(state).toMatchObject({ priorityStale: true, assigneeStale: true });
  });

  it("a fresh vm push auto-clears any stale marker — the old 'refresh' link only dismissed the flag", () => {
    let state = reduceDetailStale(submitPriority(INITIAL_STALE_STATE), { type: "error", message: STALE });
    state = reduceDetailStale(submitAssignee(state), { type: "error", message: STALE });
    expect(state).toMatchObject({ priorityStale: true, assigneeStale: true });

    const afterPush = reduceDetailStale(state, { type: "vmPush" });
    expect(afterPush).toMatchObject({ priorityStale: false, assigneeStale: false });
  });

  it("clearField dismisses only its own field (begin-edit / explicit refresh click)", () => {
    let state = reduceDetailStale(submitPriority(INITIAL_STALE_STATE), { type: "error", message: STALE });
    state = reduceDetailStale(submitAssignee(state), { type: "error", message: STALE });

    const afterClear = reduceDetailStale(state, { type: "clearField", field: "priority" });
    expect(afterClear).toMatchObject({ priorityStale: false, assigneeStale: true });
  });

  it("submitting a field optimistically clears that field's own stale marker", () => {
    const staleAssignee = reduceDetailStale(submitAssignee(INITIAL_STALE_STATE), { type: "error", message: STALE });
    expect(staleAssignee.assigneeStale).toBe(true);

    const resubmitted = submitAssignee(staleAssignee);
    expect(resubmitted).toMatchObject({ assigneeStale: false, pendingField: "assignee" });
  });

  it("dogfood round 2 (#1) — a fresh vm push after a successful submit must not let a late duplicate " +
    "error re-stale the field: submit(assignee) -> vmPush (the success) -> a delayed error for the same " +
    "in-flight request must NOT flip assigneeStale back on", () => {
    let state = submitAssignee(INITIAL_STALE_STATE);
    expect(state).toMatchObject({ pendingField: "assignee", assigneeStale: false });

    // the successful submit's own fresh task push arrives — the screen already reflects the current task.
    state = reduceDetailStale(state, { type: "vmPush" });
    expect(state.assigneeStale).toBe(false);

    // a late/duplicate response for the ALREADY-RESOLVED submit (e.g. a re-fired request from the same user
    // action) arrives after the push. Because the screen is already fresh, this must be a no-op — it must
    // NOT resurrect a stale marker for a field that just got its live update.
    state = reduceDetailStale(state, { type: "error", message: STALE });
    expect(state.assigneeStale).toBe(false);
  });
});

describe("selectedReviewablePrototype", () => {
  const proto = (id: string, state: TaskPrototypeVM["state"]): TaskPrototypeVM => ({
    id,
    state,
    sha256: id.padEnd(64, "0").slice(0, 64),
    title: id,
    author: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    available: true,
    integrity: "verified",
  });

  it("returns only the exact selected draft and never falls back to a hidden latest draft", () => {
    const list: TaskPrototypeListVM = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      readOnly: false,
      prototypes: [proto("approved", "approved"), proto("draft", "draft")],
    };

    expect(selectedReviewablePrototype(list, "draft")?.id).toBe("draft");
    expect(selectedReviewablePrototype(list, "approved")).toBeUndefined();
    expect(selectedReviewablePrototype(list, "")).toBeUndefined();
  });

  it("suppresses decisions when the manifest is read-only or has no CAS anchor", () => {
    const list: TaskPrototypeListVM = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      readOnly: false,
      prototypes: [proto("draft", "draft")],
    };

    expect(selectedReviewablePrototype({ ...list, readOnly: true }, "draft")).toBeUndefined();
    expect(selectedReviewablePrototype({ ...list, updatedAt: undefined }, "draft")).toBeUndefined();
  });
});
