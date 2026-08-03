import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools } from "../../src/bridge/tools.js";
import { decideSpawnTaskClaim } from "../../src/bridge/spawnTaskClaim.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import type { Task } from "../../src/tasks/types.js";

/**
 * t-48f504 — one operation to launch an agent FOR a board task, and a refusal at the call when it
 * cannot hold that task.
 *
 * MEASURED on 2026-08-01, three real launches of one reviewer:
 *
 *  1. pointed at a CLOSED task — the child refused, correctly, citing project guidance;
 *  2. pointed at an open task still in `inbox` with no assignee — the child refused again, correctly,
 *     because its work-on-record said "no assigned work";
 *  3. worked only after `triaged` -> `active` -> `assignee` -> respawn. FOUR operations to say
 *     "do this task", and between them a window where the spawn contract and the board disagreed.
 *
 * Both refusals were right, and both cost a full launch: the spawn SUCCEEDED each time, so the only
 * thing that could say "this agent does not hold that work" was the agent, a 13KB brief later.
 *
 * What this file pins is the pair of properties that removes the class, not the convenience:
 *
 *  - the claim is ATOMIC (`triaged` -> `active` + assignee in one store transaction), so the two
 *    records are one fact and the intermediate disagreement has nowhere to live;
 *  - TRIAGE IS STILL A HUMAN DECISION. `inbox` is refused BY NAME. Skipping it is the one shortcut a
 *    "fewer operations" fix would be tempted into, and the reason it must not happen is the same one
 *    `TASK_RECONCILE_TRANSITIONS` records: triage answers "is this work we wanted?", and pointing a
 *    launch at a task asserts the answer instead of making it.
 */

class ToolCapture {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>>();
  registerTool(
    name: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ) {
    this.handlers.set(name, handler);
  }
}

/** A delegation contract good enough to pass the spec 246 gate, so nothing else can be the refusal. */
const CONTRACT = {
  task: "carry out the delegated change",
  context: "the worktree and the failing test are described here",
  constraints: "do not push, do not merge",
  done_when: "the focused test passes",
};

let root: string;
let store: TaskStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-spawn-claim-"));
  store = new TaskStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function bridge(options: { spawnFails?: boolean } = {}) {
  const mcp = new ToolCapture();
  const spawned: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  registerTools(mcp as never, {
    workspaceRoot: root,
    caller: { kind: "agent", name: "ada" },
    tasks: store,
    notify: (message: string) => { warnings.push(message); },
    manager: {
      spawn: async (_name: string, opts: Record<string, unknown>) => {
        if (options.spawnFails) throw new Error("tmux session could not be created");
        spawned.push(opts);
      },
      session: () => "tachyon-helper",
      kindOf: () => "agent",
      isReady: async () => true,
      defOf: () => undefined,
    },
  } as never);
  return { spawn: mcp.handlers.get("spawn_agent")!, spawned, warnings };
}

/** A task parked in the given lane, reached only through transitions the store already allows. */
async function taskIn(status: Task["status"], assignee?: string): Promise<Task> {
  const created = await store.create({ title: "review the delegated change", author: "claude" });
  if (status === "inbox") return created;
  await store.update(created.id, { status: "triaged" });
  if (status === "triaged") return store.get(created.id);
  if (status === "active") return store.update(created.id, { status: "active", assignee: assignee ?? "helper" });
  await store.update(created.id, { status: "active", assignee: assignee ?? "helper" });
  return store.update(created.id, { status });
}

describe("decideSpawnTaskClaim — the decision, without a store", () => {
  it("claims a triaged task", () => {
    expect(decideSpawnTaskClaim({ id: "t-aaaaaa", status: "triaged" }, "helper")).toEqual({ kind: "claim" });
  });

  it("treats a task this same agent already holds as agreement, not as a write", () => {
    expect(decideSpawnTaskClaim({ id: "t-aaaaaa", status: "active", assignee: "helper" }, "helper"))
      .toEqual({ kind: "already-held" });
  });

  it.each(["landed", "done", "dropped"])("refuses a %s task and names the status", (status) => {
    const decision = decideSpawnTaskClaim({ id: "t-aaaaaa", status }, "helper");
    expect(decision.kind).toBe("refuse");
    expect(decision.kind === "refuse" && decision.reason).toContain(`it is '${status}'`);
  });

  it("refuses a task active under a different agent, naming the holder", () => {
    const decision = decideSpawnTaskClaim({ id: "t-aaaaaa", status: "active", assignee: "other" }, "helper");
    expect(decision.kind).toBe("refuse");
    expect(decision.kind === "refuse" && decision.reason).toContain("'other'");
  });

  /**
   * The load-bearing negative. A refusal that only forbids gets worked around (the lesson
   * `PARENT_CWD_REFUSAL` records), so the inbox message must name the operation that makes the spawn
   * legal — and that operation is a separate, deliberate triage, never something the spawn performs.
   */
  it("refuses an inbox task and points at triage as its own decision", () => {
    const decision = decideSpawnTaskClaim({ id: "t-aaaaaa", status: "inbox" }, "helper");
    expect(decision.kind).toBe("refuse");
    const reason = decision.kind === "refuse" ? decision.reason : "";
    expect(reason).toContain("it is in inbox");
    expect(reason).toContain("Triage is a deliberate decision");
    // t-f33480 — the refusal is real and stays; "human" was the part nothing enforced.
    expect(reason).toContain("recorded in the task journal");
    expect(reason).toContain("triaged");
  });
});

describe("t-48f504 — spawn_agent(claim_task) binds the launch to the board", () => {
  it("moves triaged -> active with the child as assignee, in ONE operation", async () => {
    const task = await taskIn("triaged");
    const { spawn, spawned } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: task.id, ...CONTRACT });

    expect(result.isError).toBeFalsy();
    expect(spawned).toHaveLength(1);
    // The whole point: after ONE call the board says what the brief says. No window in between —
    // status and assignee moved in the same store transaction, which is what made the four-operation
    // sequence able to disagree with itself.
    expect(store.get(task.id)).toMatchObject({ status: "active", assignee: "helper" });
  });

  it("is idempotent for the task this agent already holds", async () => {
    const task = await taskIn("active", "helper");
    const before = store.get(task.id).updatedAt;
    const { spawn, spawned } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: task.id, ...CONTRACT });

    expect(result.isError).toBeFalsy();
    expect(spawned).toHaveLength(1);
    // Not merely "still active": untouched. A respawn of the same agent onto its own task must not
    // rewrite the row, or every restart would look like a fresh assignment to whoever reads the feed.
    expect(store.get(task.id).updatedAt).toBe(before);
  });

  /**
   * (c) of the contract, and the one property a convenience fix would quietly trade away.
   *
   * The refusal is measured at the DOOR, not merely in the message: nothing spawned, and the task is
   * byte-for-byte where triage left it.
   */
  it("refuses an inbox task without spawning and without touching the board", async () => {
    const task = await taskIn("inbox");
    const before = JSON.stringify(store.get(task.id));
    const { spawn, spawned } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: task.id, ...CONTRACT });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("it is in inbox");
    expect(result.content[0]?.text).toContain("Triage is a deliberate decision");
    expect(spawned).toEqual([]);
    expect(JSON.stringify(store.get(task.id))).toBe(before);
  });

  it.each(["landed", "done", "dropped"] as const)("refuses a %s task at the call instead of launching into it", async (status) => {
    const task = await taskIn(status);
    const { spawn, spawned } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: task.id, ...CONTRACT });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(`it is '${status}'`);
    expect(spawned).toEqual([]);
    expect(store.get(task.id).status).toBe(status);
  });

  it("refuses a task another agent is already holding", async () => {
    const task = await taskIn("active", "other");
    const { spawn, spawned } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: task.id, ...CONTRACT });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("'other'");
    expect(spawned).toEqual([]);
    expect(store.get(task.id).assignee).toBe("other");
  });

  it("refuses an unknown task id by name", async () => {
    const { spawn, spawned } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: "t-abcdef", ...CONTRACT });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("t-abcdef");
    expect(spawned).toEqual([]);
  });

  /**
   * A spawn refused for an unrelated reason must not leave a claim behind. The contract gate fires
   * AFTER the claim is decided and BEFORE it is written, so an incomplete contract costs the caller a
   * retry and costs the board nothing.
   */
  it("writes no claim when the delegation contract itself is rejected", async () => {
    const task = await taskIn("triaged");
    const { spawn } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: task.id, task: "tbd" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("delegation contract");
    expect(store.get(task.id)).toMatchObject({ status: "triaged" });
    expect(store.get(task.id).assignee).toBeUndefined();
  });

  /**
   * The claim is written before the launch, because the work-on-record the child reads is projected
   * from the board DURING that launch. So a launch that then fails has to give the claim back: a board
   * holding active, assigned work for an agent that does not exist is this same defect wearing its
   * other face, and the next reader — a human, or a restart of the same name — would believe it.
   */
  it("releases the claim when the launch fails, and leaves the task where triage left it", async () => {
    const task = await taskIn("triaged");
    const { spawn } = bridge({ spawnFails: true });

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", claim_task: task.id, ...CONTRACT });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("tmux session could not be created");
    expect(store.get(task.id)).toMatchObject({ status: "triaged" });
    expect(store.get(task.id).assignee).toBeUndefined();
  });

  it("leaves the board untouched when no claim is asked for", async () => {
    const task = await taskIn("triaged");
    const { spawn, spawned } = bridge();

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", ...CONTRACT });

    expect(result.isError).toBeFalsy();
    expect(spawned).toHaveLength(1);
    // An unclaimed spawn is still legal — it is the shape the primer's precedence rule governs.
    expect(store.get(task.id)).toMatchObject({ status: "triaged" });
  });
});
