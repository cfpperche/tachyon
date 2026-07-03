import { describe, expect, it } from "vitest";
import { reduceDetailStale, INITIAL_STALE_STATE, type DetailStaleState } from "../../src/webview/task-detail/interactions.js";

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
});
