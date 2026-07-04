import { describe, it, expect } from "vitest";
import { toAgentVM, statusOf, type AgentRaw } from "../../src/sidebar/agentModel";

const raw = (o: Partial<AgentRaw> & { name: string }): AgentRaw => ({ running: false, dead: false, crashed: false, ...o });

describe("agentModel.statusOf (spec 237)", () => {
  it("crashed = dead + non-zero", () => expect(statusOf(raw({ name: "a", dead: true, crashed: true }))).toBe("crashed"));
  it("clean exit = dead + not crashed → stopped", () => expect(statusOf(raw({ name: "a", dead: true }))).toBe("stopped"));
  it("not running, not dead → stopped", () => expect(statusOf(raw({ name: "a" }))).toBe("stopped"));
  it("stopping beats running attention until stop resolves", () => expect(statusOf(raw({ name: "a", running: true, stopping: true }), "needs-input")).toBe("stopping"));
  it("running + needs-input → needs", () => expect(statusOf(raw({ name: "a", running: true }), "needs-input")).toBe("needs"));
  it("running + throttled → throttled (spec 306)", () => expect(statusOf(raw({ name: "a", running: true }), "throttled")).toBe("throttled"));
  it("running + idle → idle", () => expect(statusOf(raw({ name: "a", running: true }), "idle")).toBe("idle"));
  it("running + working/unknown → running", () => {
    expect(statusOf(raw({ name: "a", running: true }), "working")).toBe("running");
    expect(statusOf(raw({ name: "a", running: true }))).toBe("running");
  });
});

describe("agentModel.toAgentVM (spec 237)", () => {
  it("maps attention label + drops idle/undefined", () => {
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "needs-input" })).toMatchObject({ status: "needs", attention: "needs input" });
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "throttled" })).toMatchObject({ status: "throttled", attention: "throttled" });
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "working" })).toMatchObject({ status: "running", attention: "working" });
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "idle" }).attention).toBeUndefined();
  });
  it("exit sub: clean vs crashed (with exit code)", () => {
    expect(toAgentVM(raw({ name: "a", dead: true })).sub).toBe("exited (0)");
    expect(toAgentVM(raw({ name: "a", dead: true, crashed: true, exitCode: 137 })).sub).toBe("exited (137)");
    expect(toAgentVM(raw({ name: "a", running: true })).sub).toBeUndefined();
  });
  it("stopping exposes a transient sublabel", () => {
    expect(toAgentVM(raw({ name: "a", running: true, stopping: true }))).toMatchObject({ status: "stopping", sub: "stopping..." });
  });
  it("clean-exit auto-cleared rows keep exited metadata but no pane", () => {
    expect(toAgentVM(raw({ name: "a", cleanExited: true }))).toMatchObject({ status: "stopped", sub: "exited (0)", exited: true, pane: false });
  });
  it("passes through dismiss capability for stopped ad-hoc postmortem rows", () => {
    expect(toAgentVM(raw({ name: "a", cleanExited: true }), { canDismiss: true })).toMatchObject({ canDismiss: true });
  });
  it("passes through parent + capability badges", () => {
    const vm = toAgentVM(raw({ name: "child", running: true, parent: "orch" }), { worktree: "tachyon/x", harness: true, forked: true, forkable: true, resumable: false });
    expect(vm).toMatchObject({ name: "child", parent: "orch", worktree: "tachyon/x", harness: true, forked: true, forkable: true });
    expect(vm.resumable).toBeUndefined(); // false flags are omitted, not set
  });
  it("spec 352 — passes through declaredOwner without replacing runtime parent", () => {
    const vm = toAgentVM(raw({ name: "reviewer", running: true, parent: "codex", declaredOwner: "claude" }));
    expect(vm).toMatchObject({ name: "reviewer", parent: "codex", declaredOwner: "claude" });
  });
  it("spec 316: passes through persistence hook health", () => {
    const vm = toAgentVM(raw({ name: "claude", running: true }), {
      persistenceHooks: { state: "failed", reason: "syntax-error", path: "/ws/.tachyon/activity/persistence-hooks-failures.jsonl", updatedAt: "2026-07-01T00:00:00Z" },
    });
    expect(vm.persistenceHooks).toMatchObject({ state: "failed", reason: "syntax-error" });
  });
});
