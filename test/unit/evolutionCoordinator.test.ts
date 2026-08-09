import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";
import {
  EvolutionCoordinator,
  composeEvolutionReviewNotice,
} from "../../src/evolution/EvolutionCoordinator.js";
import { EvolutionStore } from "../../src/evolution/EvolutionStore.js";
import { TaskStore, type TaskMutationEvent } from "../../src/tasks/TaskStore.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tachyon-evolution-coordinator-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("EvolutionCoordinator (SDD 421 Slice 2)", () => {
  it("creates and delivers exactly one review for a real opt-in transition to done", async () => {
    const root = await tempRoot();
    const definitions = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    selfEvolution: {enabled: true}\n").config!.agents;
    const ids = ["profile-id", "review-id", "second-review"];
    const evolution = new EvolutionStore(root, { uuid: () => ids.shift()! });
    const notices: string[] = [];
    const completionEvents: TaskMutationEvent[] = [];
    const coordinator = new EvolutionCoordinator({
      store: evolution,
      declaredAgent: (name) => definitions[name],
      sessionFor: (name) => `tachyon-${name}`,
      activitySeq: () => 17,
      deliverNotice: async (_agent, line) => {
        notices.push(line);
        return { status: "notified" };
      },
    });
    let observed = Promise.resolve();
    const tasks = new TaskStore(root, {
      evolutionCompletionFor: (event) => coordinator.completionMarker(event),
      onMutation: (event) => {
        if (event.after.status === "done") completionEvents.push(event);
        observed = coordinator.onTaskMutation(event);
        return observed;
      },
    });

    const task = await tasks.create({ title: "Improve the parser", author: "human", now: "2026-07-21T10:00:00.000Z" });
    await tasks.update(task.id, { status: "triaged", assignee: "reviewer", now: "2026-07-21T10:01:00.000Z" });
    await observed;
    await tasks.update(task.id, { status: "active", now: "2026-07-21T10:02:00.000Z" });
    await observed;
    await tasks.update(task.id, { status: "done", now: "2026-07-21T10:03:00.000Z" });
    await observed;

    const reviews = await evolution.listReviews("reviewer");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      id: "review-review-id",
      taskId: task.id,
      taskTitle: "Improve the parser",
      status: "pending",
      sessionAnchor: { session: "tachyon-reviewer", activitySeq: 17 },
      delivery: { status: "notified" },
    });
    expect(notices).toEqual([composeEvolutionReviewNotice(reviews[0]!)]);

    await coordinator.onTaskMutation(completionEvents[0]!);
    expect(await evolution.listReviews("reviewer")).toHaveLength(1);
    expect(notices).toHaveLength(1);

    await tasks.update(task.id, { status: "triaged", now: "2026-07-21T10:04:00.000Z" });
    await observed;
    await tasks.update(task.id, { status: "active", now: "2026-07-21T10:05:00.000Z" });
    await observed;
    // The second execution deliberately reuses the first completion timestamp. Revision identity
    // comes from the committed nonce, not wall-clock uniqueness.
    await tasks.update(task.id, { status: "done", now: "2026-07-21T10:03:00.000Z" });
    await observed;
    expect(await evolution.listReviews("reviewer")).toHaveLength(2);
    expect(notices).toHaveLength(2);
  });

  it("ignores disabled, undeclared, landed, and non-transition updates", async () => {
    const root = await tempRoot();
    const definitions = parseConfig("agents:\n  disabled:\n    cmd: codex\n  enabled:\n    cmd: codex\n    selfEvolution: {enabled: true}\n").config!.agents;
    const evolution = new EvolutionStore(root);
    const coordinator = new EvolutionCoordinator({
      store: evolution,
      declaredAgent: (name) => definitions[name],
      sessionFor: (name) => `tachyon-${name}`,
      activitySeq: () => undefined,
      deliverNotice: async () => ({ status: "queued" }),
    });
    const base = {
      id: "t-123456",
      title: "Task",
      author: "human",
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z",
    } as const;
    await coordinator.onTaskMutation({
      before: { ...base, status: "active", assignee: "disabled" },
      after: { ...base, status: "done", assignee: "disabled", updatedAt: "2026-07-21T10:01:00.000Z" },
    });
    await coordinator.onTaskMutation({
      before: { ...base, status: "active", assignee: "ghost" },
      after: { ...base, status: "done", assignee: "ghost", updatedAt: "2026-07-21T10:01:00.000Z" },
    });
    await coordinator.onTaskMutation({
      before: { ...base, status: "active", assignee: "enabled" },
      after: { ...base, status: "landed", assignee: "enabled", updatedAt: "2026-07-21T10:01:00.000Z" },
    });
    await coordinator.onTaskMutation({
      before: { ...base, status: "done", assignee: "enabled" },
      after: { ...base, status: "done", assignee: "enabled", updatedAt: "2026-07-21T10:01:00.000Z" },
    });
    expect(await evolution.listReviews("disabled")).toEqual([]);
    expect(await evolution.listReviews("enabled")).toEqual([]);
    expect(await evolution.readProfile("enabled")).toBeUndefined();
  });

  it("records delivery failure without changing the completed Task", async () => {
    const root = await tempRoot();
    const definition = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    selfEvolution: {enabled: true}\n").config!.agents.reviewer;
    const ids = ["profile-id", "review-id"];
    const evolution = new EvolutionStore(root, { uuid: () => ids.shift()! });
    const coordinator = new EvolutionCoordinator({
      store: evolution,
      declaredAgent: (name) => name === "reviewer" ? definition : undefined,
      sessionFor: () => "tachyon-reviewer",
      activitySeq: () => 3,
      deliverNotice: async () => { throw new Error("agent 'reviewer' is not running"); },
    });
    let observed = Promise.resolve();
    const tasks = new TaskStore(root, { onMutation: (event) => (observed = coordinator.onTaskMutation(event)) });
    const task = await tasks.create({ title: "Complete anyway", author: "human" });
    await tasks.update(task.id, { status: "triaged", assignee: "reviewer" });
    await tasks.update(task.id, { status: "active" });
    const done = await tasks.update(task.id, { status: "done" });
    await observed;

    expect(done.status).toBe("done");
    expect(tasks.get(task.id).status).toBe("done");
    expect((await evolution.listReviews("reviewer"))[0]).toMatchObject({
      status: "failed",
      delivery: { status: "failed", detail: "agent 'reviewer' is not running" },
    });
  });

  it("reconciles a durable done marker when the original observer never ran", async () => {
    const root = await tempRoot();
    const definition = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    selfEvolution: {enabled: true}\n").config!.agents.reviewer;
    const ids = ["profile-id", "review-id"];
    const evolution = new EvolutionStore(root, { uuid: () => ids.shift()! });
    const notices: string[] = [];
    const coordinator = new EvolutionCoordinator({
      store: evolution,
      declaredAgent: (name) => name === "reviewer" ? definition : undefined,
      sessionFor: () => "tachyon-reviewer",
      activitySeq: () => 11,
      deliverNotice: async (_agent, notice) => { notices.push(notice); return { status: "notified" }; },
    });
    const tasks = new TaskStore(root, {
      evolutionCompletionFor: (event) => coordinator.completionMarker(event),
      // Deliberately omit onMutation: this is the process-loss window under test.
    });
    const task = await tasks.create({ title: "Recover review on reload", author: "human" });
    await tasks.update(task.id, { status: "triaged", assignee: "reviewer" });
    await tasks.update(task.id, { status: "active" });
    await tasks.update(task.id, { status: "done" });
    expect(await evolution.listReviews("reviewer")).toEqual([]);

    await coordinator.reconcileCompletedTasks(new TaskStore(root).listRaw());
    expect((await evolution.listReviews("reviewer"))[0]).toMatchObject({
      taskId: task.id,
      completionRevision: tasks.get(task.id).evolutionCompletion!.revision,
      delivery: { status: "notified" },
    });
    expect(notices).toHaveLength(1);
    await coordinator.reconcileCompletedTasks(new TaskStore(root).listRaw());
    expect(await evolution.listReviews("reviewer")).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it("marks a queued review failed when its assigned agent becomes unavailable", async () => {
    const root = await tempRoot();
    const definition = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    selfEvolution: {enabled: true}\n").config!.agents.reviewer;
    const ids = ["profile-id", "review-id"];
    const evolution = new EvolutionStore(root, { uuid: () => ids.shift()! });
    const coordinator = new EvolutionCoordinator({
      store: evolution,
      declaredAgent: (name) => name === "reviewer" ? definition : undefined,
      sessionFor: () => "tachyon-reviewer",
      activitySeq: () => 9,
      deliverNotice: async () => ({ status: "queued" }),
    });
    const base = {
      id: "t-123456",
      title: "Queued review",
      author: "human",
      assignee: "reviewer",
      createdAt: "2026-07-21T10:00:00.000Z",
    } as const;
    await coordinator.onTaskMutation({
      before: { ...base, status: "active", updatedAt: "2026-07-21T10:01:00.000Z" },
      after: { ...base, status: "done", lastDeliverer: "reviewer", updatedAt: "2026-07-21T10:02:00.000Z" },
    });
    expect((await evolution.listReviews("reviewer"))[0]).toMatchObject({ status: "pending", delivery: { status: "queued" } });

    await coordinator.onAgentUnavailable("reviewer", "agent 'reviewer' stopped before submitting the review");
    expect((await evolution.listReviews("reviewer"))[0]).toMatchObject({
      status: "failed",
      delivery: { status: "failed", detail: "agent 'reviewer' stopped before submitting the review" },
    });
  });
});
