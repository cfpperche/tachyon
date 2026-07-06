import { describe, it, expect } from "vitest";
import { actionsFor, primaryActions, moreActions, type ActionId } from "../../src/sidebar/actions";
import type { AgentVM } from "../../src/sidebar/types";

const A = (o: Partial<AgentVM> & { status: AgentVM["status"] }): AgentVM => ({ name: "x", ai: true, ...o });

describe("sidebar action matrix (spec 237)", () => {
  it("running → graceful stop + forced kill + restart, no spawn", () => {
    const a = actionsFor(A({ status: "running" }));
    expect(a).toContain("stop"); expect(a).toContain("kill"); expect(a).toContain("restart"); expect(a).not.toContain("spawn");
    expect(a[0]).toBe("activity"); // spec 238 — the cockpit is the primary action for an AI agent with a pane
    expect(a[1]).toBe("probes"); // spec 322 — durable per-agent probe history sits with its sibling record view
    expect(a[2]).toBe("inspect"); // the raw terminal follows as the escape hatch
    expect(primaryActions(A({ status: "running" }))).not.toContain("stop");
    expect(primaryActions(A({ status: "running" }))).not.toContain("kill");
    expect(moreActions(A({ status: "running" }))).toContain("stop");
    expect(moreActions(A({ status: "running" }))).toContain("kill");
  });

  it("spec 238 — activity is offered for AI agents even without a live pane, but not for terminals", () => {
    expect(primaryActions(A({ status: "running" }))).toContain("activity");
    expect(actionsFor(A({ status: "running", ai: false }))).not.toContain("activity"); // terminal: no transcript
    expect(actionsFor(A({ status: "stopped" }))).toContain("activity"); // durable history, not tied to a pane
    expect(primaryActions(A({ status: "stopped", resumable: true }))).toEqual(["activity"]);
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
    expect(a).toEqual(expect.arrayContaining(["activity", "restart"]));
    expect(a).not.toContain("inspect");
    expect(a).not.toContain("stop");
    expect(a).not.toContain("spawn");
    const inline = primaryActions(A({ status: "stopped", exited: true, resumable: true }));
    expect(inline).toEqual(["activity"]);
    expect(inline).not.toContain("inspect");
    expect(inline).not.toContain("kill");
    expect(moreActions(A({ status: "stopped", exited: true, resumable: true }))).toEqual(expect.arrayContaining(["restart", "resume"]));
    expect(moreActions(A({ status: "stopped", exited: true }))).toContain("kill"); // dead pane still exists
    expect(actionsFor(A({ status: "stopped", exited: true, resumable: true }))).toContain("resume");
  });
  it("clean exit after auto-clear → Activity/Restart/Resume/Remove, no Kill and no Start", () => {
    const a = A({ status: "stopped", exited: true, pane: false, resumable: true, canDismiss: true });
    expect(actionsFor(a)).toEqual(expect.arrayContaining(["activity", "restart", "resume"]));
    expect(actionsFor(a)).toContain("remove");
    expect(actionsFor(a)).not.toContain("inspect");
    expect(actionsFor(a)).not.toContain("kill");
    expect(actionsFor(a)).not.toContain("spawn");
    expect(primaryActions(a)).toEqual(["activity"]);
    expect(moreActions(a)).toEqual(expect.arrayContaining(["restart", "resume", "remove"]));
  });
  it("restart is offered for declared and ad-hoc agents, but only in the overflow menu", () => {
    const declared = A({ status: "running" });
    const adhoc = A({ status: "running", adhoc: true, canDismiss: true });
    expect(actionsFor(declared)).toContain("restart");
    expect(primaryActions(declared)).not.toContain("restart");
    expect(moreActions(declared)).toContain("restart");
    expect(actionsFor(adhoc)).toContain("restart");
    expect(primaryActions(adhoc)).not.toContain("restart");
    expect(moreActions(adhoc)).toContain("restart");
  });
  it("clean-exit ad-hoc postmortem keeps activity inline and restart in overflow", () => {
    const a = A({ status: "stopped", exited: true, pane: false, resumable: true, adhoc: true, canDismiss: true });
    expect(actionsFor(a)).toEqual(expect.arrayContaining(["activity", "restart", "resume", "remove"]));
    expect(primaryActions(a)).not.toContain("restart");
    expect(primaryActions(a)).toEqual(["activity"]);
    expect(moreActions(a)).toEqual(expect.arrayContaining(["restart", "resume", "remove"]));
  });
  it("stopping → durable-record views + Remove; blocks pane-contending actions while graceful stop is in flight", () => {
    // spec 322 — probes, like activity, reads durable on-disk records and never contends for the pane,
    // so it stays available during a graceful stop.
    expect(actionsFor(A({ status: "stopping" }))).toEqual(["activity", "probes", "remove"]);
    expect(primaryActions(A({ status: "stopping" }))).toEqual(["activity"]);
    expect(moreActions(A({ status: "stopping" }))).toEqual(["probes", "remove"]);
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
    expect(actionsFor(A({ status: "running", adhoc: true }))).toContain("remove");
    expect(actionsFor(A({ status: "stopped", adhoc: true, canDismiss: true }))).toContain("remove");
    expect(actionsFor(A({ status: "running", worktree: "b" }))).toEqual(expect.arrayContaining(["reviewWorktree", "createPr", "removeWorktree"]));
  });
  it("spec 322 — probes: offered wherever activity is (ai, pane-independent), more-menu only, never terminals", () => {
    expect(actionsFor(A({ status: "running" }))).toContain("probes");
    expect(actionsFor(A({ status: "stopped" }))).toContain("probes"); // durable records, no pane needed
    expect(actionsFor(A({ status: "running", ai: false }))).not.toContain("probes"); // terminals never launch probes
    expect(primaryActions(A({ status: "running" }))).not.toContain("probes"); // "…" menu only
    expect(moreActions(A({ status: "running" }))).toContain("probes");
  });
  it("spec 306 — a throttled agent is running-like: keeps reanchor/reinjectContinuity", () => {
    expect(actionsFor(A({ status: "throttled", ai: true }))).toContain("reanchor");
    expect(actionsFor(A({ status: "throttled", ai: true }))).toContain("reinjectContinuity");
    expect(actionsFor(A({ status: "throttled" }))).toContain("stop");
    expect(actionsFor(A({ status: "throttled" }))).toContain("kill");
    expect(actionsFor(A({ status: "throttled" }))).not.toContain("spawn");
  });
  it("management actions always present", () => {
    expect(actionsFor(A({ status: "running" }))).toEqual(expect.arrayContaining(["edit", "clone", "rename", "remove"]));
  });
  it("removal is a single action for declared and ad-hoc agents", () => {
    for (const a of [
      A({ status: "running" }),
      A({ status: "stopped" }),
      A({ status: "running", adhoc: true }),
      A({ status: "stopped", adhoc: true, canDismiss: true }),
    ]) {
      const actions = actionsFor(a);
      expect(actions).toContain("remove");
      expect(actions).not.toContain("dismiss");
      expect(actions).not.toContain("delete");
    }
  });
  it("primary is capped at 5 and inline+more partition the set with no overlap", () => {
    const a = A({ status: "running", forkable: true, verifiable: true, worktree: "b", adhoc: true });
    const prim = primaryActions(a), more = moreActions(a);
    expect(prim.length).toBeLessThanOrEqual(5);
    expect(prim.filter((x) => more.includes(x))).toEqual([]); // disjoint
    expect(new Set([...prim, ...more])).toEqual(new Set(actionsFor(a))); // cover the full set
  });

  it("inline toolbar is read-only only; lifecycle/destructive actions live in overflow for declared and ad-hoc agents", () => {
    const unsafe: ActionId[] = ["stop", "restart", "remove", "resume", "kill", "spawn"];
    for (const a of [
      A({ status: "running", resumable: true }),
      A({ status: "running", resumable: true, adhoc: true, canDismiss: true }),
      A({ status: "stopped", resumable: true }),
      A({ status: "stopped", resumable: true, adhoc: true, canDismiss: true }),
      A({ status: "crashed", resumable: true }),
      A({ status: "crashed", resumable: true, adhoc: true, canDismiss: true }),
    ]) {
      expect(primaryActions(a).filter((id) => !["activity", "inspect"].includes(id))).toEqual([]);
      const more = moreActions(a);
      for (const id of unsafe) {
        if (actionsFor(a).includes(id)) expect(more).toContain(id);
      }
    }
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
