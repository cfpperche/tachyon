import { describe, expect, it } from "vitest";
import { nextTask } from "../../src/tasks/nextTask.js";
import type { Task } from "../../src/tasks/types.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "t-000001",
    title: "task",
    status: "triaged",
    author: "human",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("nextTask", () => {
  it("prefers assigned-to-me work over hotter unassigned work", () => {
    const mine = task({ id: "t-000001", assignee: "codex", priority: 3 });
    const global = task({ id: "t-000002", priority: 0 });
    expect(nextTask({ agent: "codex", tasks: [global, mine] })).toMatchObject({ task: { id: mine.id } });
  });

  it("offers active work whose unavailable executor released ownership (t-49d7ec)", () => {
    const released = task({ id: "t-000001", status: "active" });
    expect(nextTask({ agent: "replacement", tasks: [released] })).toMatchObject({ task: { id: released.id } });
  });

  it("orders by priority, human rank, createdAt, then id", () => {
    const tasks = [
      task({ id: "t-000003", priority: 1, rank: "b", createdAt: "2026-07-01T00:00:00.000Z" }),
      task({ id: "t-000002", priority: 1, rank: "a", createdAt: "2026-07-03T00:00:00.000Z" }),
      task({ id: "t-000001", priority: 2, rank: "a", createdAt: "2026-07-01T00:00:00.000Z" }),
    ];
    expect(nextTask({ agent: "codex", tasks })).toMatchObject({ task: { id: "t-000002" } });
  });

  it("excludes unresolved deps but treats dangling deps as attention, not blockage", () => {
    const blocked = task({ id: "t-000001", deps: ["t-000002"], priority: 0 });
    const dep = task({ id: "t-000002", status: "active", assignee: "claude" });
    const dangling = task({ id: "t-000003", deps: ["t-ffffff"], priority: 1 });
    const result = nextTask({ agent: "codex", tasks: [blocked, dep, dangling] });
    expect(result).toMatchObject({ task: { id: dangling.id }, attention: [{ code: "dangling_dep", ref: "t-ffffff" }] });
  });

  it("never offers landed work and does not treat landed dependencies as satisfied", () => {
    const landed = task({ id: "t-000001", status: "landed", assignee: "codex" });
    expect(nextTask({ agent: "codex", tasks: [landed] })).toEqual({ empty: true, reason: "no-tasks" });

    const blocked = task({ id: "t-000002", deps: [landed.id] });
    expect(nextTask({ agent: "codex", tasks: [blocked, landed] })).toEqual({ empty: true, reason: "all-blocked" });
  });

  it("keeps human-assigned tasks out of agent selection", () => {
    const human = task({ id: "t-000001", assignee: "human", priority: 0 });
    const agent = task({ id: "t-000002", priority: 1 });
    expect(nextTask({ agent: "codex", tasks: [human, agent] })).toMatchObject({ task: { id: agent.id } });
    expect(nextTask({ agent: "human", tasks: [human, agent] })).toMatchObject({ task: { id: human.id } });
  });

  it("does not use derived SDD lifecycle states as selection policy", () => {
    const active = task({ id: "t-000001", status: "active", assignee: "codex", artifact_refs: [{ type: "sdd", ref: "325" }] });
    expect(nextTask({ agent: "codex", tasks: [active], derived: { [active.id]: { sdd: { type: "sdd", ref: "325", status: "in-progress" } } } })).toMatchObject({ task: { id: active.id } });
    expect(nextTask({ agent: "codex", tasks: [active], derived: { [active.id]: { sdd: { type: "sdd", ref: "325", status: "shipped" } } } })).toMatchObject({ task: { id: active.id } });
    expect(nextTask({ agent: "codex", tasks: [active], derived: { [active.id]: { sdd: { type: "sdd", ref: "325", status: "deferred" } } } })).toMatchObject({ task: { id: active.id } });
  });

  it("returns structured empty reasons", () => {
    expect(nextTask({ agent: "codex", tasks: [] })).toEqual({ empty: true, reason: "no-tasks" });
    expect(nextTask({ agent: "codex", tasks: [task({ id: "t-000001", assignee: "claude" })] })).toEqual({ empty: true, reason: "all-assigned-elsewhere" });
    expect(nextTask({ agent: "codex", tasks: [task({ id: "t-000001", deps: ["t-000002"] }), task({ id: "t-000002", status: "active", assignee: "claude" })] })).toEqual({ empty: true, reason: "all-blocked" });
  });
});
