import { describe, it, expect } from "vitest";
import { runContextValue, nodeContextValue, runCancellable, nodeApprovable, runIcon, nodeIcon } from "../../src/pipeline/pipelinePresentation.js";
import type { NodeStatus, RunStatus } from "../../src/pipeline/runState.js";

const RUN_STATUSES: RunStatus[] = ["running", "paused", "completed", "failed"];
const NODE_STATUSES: NodeStatus[] = ["pending", "running", "blocked", "awaiting-approval", "done", "failed"];

describe("pipeline presentation (menu-gating contract)", () => {
  it("contextValues are the prefixed status (what package.json `when` matches)", () => {
    expect(runContextValue("paused")).toBe("pipeline-run-paused");
    expect(nodeContextValue("awaiting-approval")).toBe("pipeline-node-awaiting-approval");
  });

  it("Approve/Reject apply ONLY to an awaiting-approval node", () => {
    for (const s of NODE_STATUSES) expect(nodeApprovable(s)).toBe(s === "awaiting-approval");
  });

  it("Cancel applies only to a running or paused run", () => {
    expect(RUN_STATUSES.filter(runCancellable).sort()).toEqual(["paused", "running"]);
  });

  it("every status maps to a non-empty icon", () => {
    for (const s of RUN_STATUSES) expect(runIcon(s)).toBeTruthy();
    for (const s of NODE_STATUSES) expect(nodeIcon(s)).toBeTruthy();
  });
});
