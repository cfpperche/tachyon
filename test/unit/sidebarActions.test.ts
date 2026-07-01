import { describe, it, expect } from "vitest";
import { actionsFor, primaryActions, moreActions } from "../../src/sidebar/actions";
import type { AgentVM } from "../../src/sidebar/types";

const A = (o: Partial<AgentVM> & { status: AgentVM["status"] }): AgentVM => ({ name: "x", ai: true, ...o });

describe("sidebar action matrix (spec 237)", () => {
  it("running → graceful stop + forced kill + restart, no spawn", () => {
    const a = actionsFor(A({ status: "running" }));
    expect(a).toContain("stop"); expect(a).toContain("kill"); expect(a).toContain("restart"); expect(a).not.toContain("spawn");
    expect(a[0]).toBe("activity"); // spec 238 — the cockpit is the primary action for an AI agent with a pane
    expect(a[1]).toBe("inspect"); // the raw terminal sits right beside it as the escape hatch
    expect(primaryActions(A({ status: "running" }))).toContain("stop");
    expect(primaryActions(A({ status: "running" }))).not.toContain("kill");
    expect(moreActions(A({ status: "running" }))).toContain("kill");
  });

  it("spec 238 — activity is offered for AI agents even without a live pane, but not for terminals", () => {
    expect(primaryActions(A({ status: "running" }))).toContain("activity");
    expect(actionsFor(A({ status: "running", ai: false }))).not.toContain("activity"); // terminal: no transcript
    expect(actionsFor(A({ status: "stopped" }))).toContain("activity"); // durable history, not tied to a pane
    expect(primaryActions(A({ status: "stopped", resumable: true }))).toEqual(expect.arrayContaining(["activity", "spawn", "resume"]));
    expect(actionsFor(A({ status: "stopped", exited: true }))).toContain("activity"); // clean-exit pane has a transcript
  });
  it("crashed → inspect + kill + restart", () => {
    expect(actionsFor(A({ status: "crashed" }))).toEqual(expect.arrayContaining(["inspect", "kill", "restart"]));
    expect(actionsFor(A({ status: "crashed" }))).not.toContain("stop");
  });
  it("stopped → spawn; + resume only when resumable; NO inspect (no pane to open)", () => {
    expect(actionsFor(A({ status: "stopped" }))).toContain("spawn");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("resume");
    expect(actionsFor(A({ status: "stopped", resumable: true }))).toContain("resume");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("kill");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("inspect");
    expect(primaryActions(A({ status: "stopped" }))).not.toContain("inspect");
  });
  it("clean exit (stopped + exited) → no Open terminal; Activity/Restart/Resume, NOT spawn", () => {
    const a = actionsFor(A({ status: "stopped", exited: true }));
    expect(a).toEqual(expect.arrayContaining(["activity", "kill", "restart"]));
    expect(a).not.toContain("inspect");
    expect(a).not.toContain("stop");
    expect(a).not.toContain("spawn");
    const inline = primaryActions(A({ status: "stopped", exited: true, resumable: true }));
    expect(inline).toEqual(expect.arrayContaining(["activity", "restart", "resume"]));
    expect(inline).not.toContain("inspect");
    expect(inline).not.toContain("kill");
    expect(moreActions(A({ status: "stopped", exited: true }))).toContain("kill");
    expect(actionsFor(A({ status: "stopped", exited: true, resumable: true }))).toContain("resume");
  });
  it("clean exit after auto-clear → Activity/Restart/Resume, no Kill and no Start", () => {
    const a = A({ status: "stopped", exited: true, pane: false, resumable: true });
    expect(actionsFor(a)).toEqual(expect.arrayContaining(["activity", "restart", "resume"]));
    expect(actionsFor(a)).not.toContain("inspect");
    expect(actionsFor(a)).not.toContain("kill");
    expect(actionsFor(a)).not.toContain("spawn");
    expect(primaryActions(a)).toEqual(expect.arrayContaining(["activity", "restart", "resume"]));
  });
  it("stopping → only Activity; blocks pane-contending actions while graceful stop is in flight", () => {
    expect(actionsFor(A({ status: "stopping" }))).toEqual(["activity"]);
    expect(primaryActions(A({ status: "stopping" }))).toEqual(["activity"]);
    expect(moreActions(A({ status: "stopping" }))).toEqual([]);
  });
  it("resume offered on crashed when resumable (mirrors the tree)", () => {
    expect(actionsFor(A({ status: "crashed", resumable: true }))).toContain("resume");
    expect(actionsFor(A({ status: "crashed" }))).not.toContain("resume");
  });
  it("capability gates: fork/verify/reanchor/promote/worktree", () => {
    expect(actionsFor(A({ status: "running", forkable: true }))).toContain("fork");
    expect(actionsFor(A({ status: "idle", verifiable: true }))).toContain("verify");
    expect(actionsFor(A({ status: "running", ai: true }))).toContain("reanchor");
    expect(actionsFor(A({ status: "stopped", ai: false }))).not.toContain("reanchor");
    expect(actionsFor(A({ status: "stopped", adhoc: true }))).toContain("promote");
    expect(actionsFor(A({ status: "running", worktree: "b" }))).toEqual(expect.arrayContaining(["reviewWorktree", "createPr", "removeWorktree"]));
  });
  it("spec 306 — a throttled agent is running-like: keeps reanchor/reinjectContinuity", () => {
    expect(actionsFor(A({ status: "throttled", ai: true }))).toContain("reanchor");
    expect(actionsFor(A({ status: "throttled", ai: true }))).toContain("reinjectContinuity");
    expect(actionsFor(A({ status: "throttled" }))).toContain("stop");
    expect(actionsFor(A({ status: "throttled" }))).toContain("kill");
    expect(actionsFor(A({ status: "throttled" }))).not.toContain("spawn");
  });
  it("management actions always present", () => {
    expect(actionsFor(A({ status: "running" }))).toEqual(expect.arrayContaining(["edit", "clone", "rename", "delete"]));
  });
  it("primary is capped at 5 and inline+more partition the set with no overlap", () => {
    const a = A({ status: "running", forkable: true, verifiable: true, worktree: "b", adhoc: true });
    const prim = primaryActions(a), more = moreActions(a);
    expect(prim.length).toBeLessThanOrEqual(5);
    expect(prim.filter((x) => more.includes(x))).toEqual([]); // disjoint
    expect(new Set([...prim, ...more])).toEqual(new Set(actionsFor(a))); // cover the full set
  });

  it("fork lives in the 'more' menu, never inline — the quick-actions bar is runtime-uniform", () => {
    const forkable = A({ status: "running", ai: true, forkable: true });
    expect(primaryActions(forkable)).not.toContain("fork");
    expect(moreActions(forkable)).toContain("fork");
    // the inline bar is identical whether or not the runtime supports fork
    const plain = A({ status: "running", ai: true });
    expect(primaryActions(forkable)).toEqual(primaryActions(plain));
  });
});
