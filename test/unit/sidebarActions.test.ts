import { describe, it, expect } from "vitest";
import { actionsFor, primaryActions, moreActions } from "../../src/sidebar/actions";
import type { AgentVM } from "../../src/sidebar/types";

const A = (o: Partial<AgentVM> & { status: AgentVM["status"] }): AgentVM => ({ name: "x", ai: true, ...o });

describe("sidebar action matrix (spec 237)", () => {
  it("running → kill + restart, no spawn", () => {
    const a = actionsFor(A({ status: "running" }));
    expect(a).toContain("kill"); expect(a).toContain("restart"); expect(a).not.toContain("spawn");
    expect(a[0]).toBe("inspect"); // first when present (running/crashed)
  });
  it("crashed → inspect + kill + restart", () => {
    expect(actionsFor(A({ status: "crashed" }))).toEqual(expect.arrayContaining(["inspect", "kill", "restart"]));
  });
  it("stopped → spawn; + resume only when resumable; NO inspect (no pane to open)", () => {
    expect(actionsFor(A({ status: "stopped" }))).toContain("spawn");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("resume");
    expect(actionsFor(A({ status: "stopped", resumable: true }))).toContain("resume");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("kill");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("inspect");
    expect(primaryActions(A({ status: "stopped" }))).not.toContain("inspect");
  });
  it("capability gates: fork/verify/reanchor/promote/worktree", () => {
    expect(actionsFor(A({ status: "running", fork: true }))).toContain("fork");
    expect(actionsFor(A({ status: "idle", verifiable: true }))).toContain("verify");
    expect(actionsFor(A({ status: "running", ai: true }))).toContain("reanchor");
    expect(actionsFor(A({ status: "stopped", ai: false }))).not.toContain("reanchor");
    expect(actionsFor(A({ status: "stopped", adhoc: true }))).toContain("promote");
    expect(actionsFor(A({ status: "running", worktree: "b" }))).toEqual(expect.arrayContaining(["reviewWorktree", "createPr", "removeWorktree"]));
  });
  it("management actions always present", () => {
    expect(actionsFor(A({ status: "running" }))).toEqual(expect.arrayContaining(["edit", "clone", "rename", "delete"]));
  });
  it("primary is capped at 5 and inline+more partition the set with no overlap", () => {
    const a = A({ status: "running", fork: true, verifiable: true, worktree: "b", adhoc: true });
    const prim = primaryActions(a), more = moreActions(a);
    expect(prim.length).toBeLessThanOrEqual(5);
    expect(prim.filter((x) => more.includes(x))).toEqual([]); // disjoint
    expect(new Set([...prim, ...more])).toEqual(new Set(actionsFor(a))); // cover the full set
  });
});
