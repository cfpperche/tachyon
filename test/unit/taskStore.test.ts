import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowedTransitions, TaskStore } from "../../src/tasks/TaskStore.js";
import { TASK_STATUSES } from "../../src/tasks/types.js";

let root: string;
let store: TaskStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-tasks-"));
  store = new TaskStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskStore", () => {
  function writeSpec(slug: string, status: string): void {
    fs.mkdirSync(path.join(root, "docs", "specs", slug), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "specs", slug, "spec.md"), `**Status:** ${status}\n`, "utf8");
  }

  it("creates inbox tasks as per-task files and omits derived fields from disk", async () => {
    const task = await store.create({ title: "  Investigate queue  ", author: "codex", artifact_refs: [{ type: "linear", ref: "ENG-42" }], now: "2026-07-02T00:00:00.000Z" });
    expect(task).toMatchObject({ title: "Investigate queue", author: "codex", status: "inbox" });
    const raw = JSON.parse(fs.readFileSync(path.join(root, ".tachyon", "tasks", `${task.id}.json`), "utf8"));
    expect(raw.attention).toBeUndefined();
    expect(raw.derived).toBeUndefined();
    expect(new TaskStore(root).get(task.id)).toMatchObject({ id: task.id, title: "Investigate queue" });
  });

  it("rejects oversized create fields atomically with bounded domain errors", async () => {
    const secretBody = `SECRET-${"🔒".repeat(3_994)}`;
    await expect(store.create({ title: "Four-slice delivery", author: "codex", body: secretBody }))
      .rejects.toThrow("create_task body received 4001 code points; maximum 4000");
    await expect(store.create({ title: "t".repeat(301), author: "codex" }))
      .rejects.toThrow("create_task title received 301 code points; maximum 300");
    await expect(store.create({
      title: "Too many refs",
      author: "codex",
      artifact_refs: Array.from({ length: 11 }, (_, index) => ({ type: "file", ref: `docs/${index}` })),
    })).rejects.toThrow("create_task artifact_refs received 11 entries; maximum 10");
    await expect(store.create({ title: "Long ref", author: "codex", artifact_refs: [{ type: "file", ref: "r".repeat(501) }] }))
      .rejects.toThrow("create_task artifact_refs.ref received 501 code points; maximum 500");

    expect(store.listRaw()).toEqual([]);
    expect(fs.existsSync(store.dir)).toBe(false);
    try {
      await store.create({ title: "Four-slice delivery", author: "codex", body: secretBody });
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
      expect(String(error).length).toBeLessThan(1_000);
    }
  });

  it("skips tmp and corrupt files during list", async () => {
    const task = await store.create({ title: "valid", author: "human" });
    fs.writeFileSync(path.join(root, ".tachyon", "tasks", "t-ffffff.json"), "{ nope", "utf8");
    fs.writeFileSync(path.join(root, ".tachyon", "tasks", "t-eeeeee.json.tmp.1"), JSON.stringify({}), "utf8");
    expect(store.listRaw().map((t) => t.id)).toEqual([task.id]);
  });

  it("allows exactly one concurrent CAS claim", async () => {
    const task = await store.create({ title: "claim me", author: "human" });
    await store.update(task.id, { status: "triaged" });
    const [a, b] = await Promise.allSettled([
      store.update(task.id, { assignee: "codex", expect: { assignee: null } }),
      store.update(task.id, { assignee: "claude", expect: { assignee: null } }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(store.get(task.id).assignee).toMatch(/^(codex|claude)$/);
  });

  it("enforces transitions and field mutability", async () => {
    const task = await store.create({ title: "flow", author: "human" });
    await expect(store.update(task.id, { assignee: "codex" })).rejects.toThrow(/assignee is mutable only/);
    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await expect(store.update(task.id, { status: "done" })).rejects.toThrow(/invalid status transition/);
    await store.update(task.id, { status: "active" });
    await expect(store.update(task.id, { assignee: null })).rejects.toThrow(/active tasks require assignee/);
    await store.update(task.id, { status: "done" });
    await expect(store.update(task.id, { title: "late edit" })).rejects.toThrow(/immutable/);
  });

  it("observes committed updates without letting observer failures change the Task result", async () => {
    const events: Array<{ before: string; after: string; persisted: string }> = [];
    const observed = new TaskStore(root, {
      onMutation: (event) => {
        events.push({
          before: event.before.status,
          after: event.after.status,
          persisted: new TaskStore(root).get(event.after.id).status,
        });
      },
    });
    const task = await observed.create({ title: "committed observer", author: "human" });
    const triaged = await observed.update(task.id, { status: "triaged" });
    expect(triaged.status).toBe("triaged");
    expect(events).toEqual([{ before: "inbox", after: "triaged", persisted: "triaged" }]);

    const syncFailure = new TaskStore(root, { onMutation: () => { throw new Error("observer failed"); } });
    await expect(syncFailure.update(task.id, { status: "active", assignee: "codex" }))
      .resolves.toMatchObject({ status: "active" });
    expect(syncFailure.get(task.id).status).toBe("active");

    const asyncFailure = new TaskStore(root, { onMutation: async () => { throw new Error("observer rejected"); } });
    await expect(asyncFailure.update(task.id, { status: "done" }))
      .resolves.toMatchObject({ status: "done" });
    await Promise.resolve();
    expect(asyncFailure.get(task.id).status).toBe("done");
  });

  it("persists an evolution completion obligation before an asynchronous observer can be lost", async () => {
    const revision = "a".repeat(64);
    const tasks = new TaskStore(root, {
      evolutionCompletionFor: (event) => event.after.assignee
        ? { agent: event.after.assignee, revision }
        : undefined,
      onMutation: async () => { throw new Error("process ended before observer work"); },
    });
    const task = await tasks.create({ title: "durable evolution obligation", author: "human" });
    await tasks.update(task.id, { status: "triaged", assignee: "reviewer" });
    await tasks.update(task.id, { status: "active" });
    await expect(tasks.update(task.id, { status: "done" })).resolves.toMatchObject({
      evolutionCompletion: { agent: "reviewer", revision },
    });
    await Promise.resolve();
    expect(new TaskStore(root).get(task.id).evolutionCompletion).toEqual({ agent: "reviewer", revision });
  });

  // t-370286 — a prematurely-triaged task can be returned for re-evaluation; the move unscopes it.
  it("triaged → inbox returns a task for re-evaluation and clears the assignee (t-370286)", async () => {
    const task = await store.create({ title: "too early", author: "human" });
    await store.update(task.id, { status: "triaged", assignee: "codex", priority: 1 });
    const back = await store.update(task.id, { status: "inbox" });
    expect(back.status).toBe("inbox");
    expect(back.assignee).toBeUndefined(); // assignee is forbidden in inbox — the transition unscopes
    expect(back.priority).toBe(1); // priority is inbox-legal and survives (only ownership is undone)
    await expect(store.update(task.id, { status: "inbox" })).rejects.toThrow(/at least one changed field/);
    const again = await store.update(task.id, { status: "triaged" });
    expect(again.status).toBe("triaged"); // and it can be re-triaged normally
  });

  it("derives SDD status only when an sdd artifact ref exists and local spec is present", async () => {
    writeSpec("325-task-queue-entity", "shipped");
    const task = await store.create({ title: "sdd", author: "human", artifact_refs: [{ type: "sdd", ref: "325-task-queue-entity" }] });
    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await store.update(task.id, { status: "active" });
    const view = store.getView(task.id);
    expect(view.derived?.sdd?.status).toBe("shipped");
    expect(view.attention ?? []).not.toContainEqual(expect.objectContaining({ code: "ready_to_close" }));
    expect(store.next("codex")).toEqual({ empty: true, reason: "no-tasks" });
    await store.update(task.id, { status: "done" });
    expect(store.get(task.id).status).toBe("done");
  });

  it("supports landed as a first-class SDD-gated status", async () => {
    writeSpec("360-landed", "in-progress");
    const task = await store.create({ title: "landed flow", author: "human", artifact_refs: [{ type: "sdd", ref: "360-landed" }] });
    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await store.update(task.id, { status: "active" });

    const landed = await store.update(task.id, { status: "landed" });
    expect(landed.status).toBe("landed");
    expect(store.getView(task.id).attention ?? []).not.toContainEqual(expect.objectContaining({ code: "ready_to_close" }));
    await expect(store.update(task.id, { status: "done" })).rejects.toThrow(/cannot be marked done while SDD artifact/);

    await store.update(task.id, { status: "active" });
    await store.update(task.id, { status: "landed" });
    writeSpec("360-landed", "shipped");
    expect(store.getView(task.id).attention).toContainEqual(expect.objectContaining({ code: "ready_to_close" }));
    await store.update(task.id, { status: "done" });
    expect(store.get(task.id).status).toBe("done");
  });

  it("allowedTransitions exposes the landed lane", () => {
    expect(allowedTransitions("active")).toEqual(["landed", "done", "triaged", "dropped"]);
    expect(allowedTransitions("landed")).toEqual(["done", "active", "triaged", "dropped"]);
  });

  it("fails closed when SDD artifact refs are cleared while marking done", async () => {
    writeSpec("326-sdd-plugin", "in-progress");
    const task = await store.create({ title: "sdd", author: "human", artifact_refs: [{ type: "sdd", ref: "326-sdd-plugin" }] });
    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await store.update(task.id, { status: "active" });
    await expect(store.update(task.id, { status: "done", artifact_refs: null })).rejects.toThrow(/can be cleared or replaced only while task is triaged/);
    expect(store.get(task.id).artifact_refs).toEqual([{ type: "sdd", ref: "326-sdd-plugin" }]);
  });

  it("defaults SDD artifact refs to deliverable role for existing gating behavior", async () => {
    writeSpec("328-default-deliverable", "in-progress");
    const task = await store.create({ title: "default deliverable", author: "human", artifact_refs: [{ type: "sdd", ref: "328-default-deliverable" }] });
    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await store.update(task.id, { status: "active" });

    expect(store.getView(task.id).derived?.sdd).toMatchObject({ ref: "328-default-deliverable", status: "in-progress" });
    await expect(store.update(task.id, { status: "done" })).rejects.toThrow(/cannot be marked done while SDD artifact/);
  });

  it("treats role:relation SDD refs as non-gating related artifacts", async () => {
    writeSpec("358-runtime-profile", "in-progress");
    const task = await store.create({
      title: "related runtime profile",
      author: "human",
      artifact_refs: [{ type: "sdd", ref: "358-runtime-profile", role: "relation" }],
    });
    expect(task.artifact_refs).toEqual([{ type: "sdd", ref: "358-runtime-profile", role: "relation" }]);

    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await store.update(task.id, { status: "active" });
    expect(store.getView(task.id).derived?.sdd).toBeUndefined();
    expect(store.next("codex")).toMatchObject({ task: { id: task.id } });

    const cleared = await store.update(task.id, { artifact_refs: null });
    expect(cleared.artifact_refs).toBeUndefined();
    await store.update(task.id, { status: "done" });
    expect(store.get(task.id).status).toBe("done");
  });

  it("rejects unknown artifact ref roles", async () => {
    await expect(store.create({ title: "bad role", author: "human", artifact_refs: [{ type: "sdd", ref: "358", role: "related" as never }] })).rejects.toThrow(/artifact_refs\.role/);
  });

  it("allows clearing delegated SDD refs only in triaged tasks", async () => {
    writeSpec("327-review", "in-progress");
    const task = await store.create({ title: "clear sdd", author: "human", artifact_refs: [{ type: "sdd", ref: "327-review" }] });
    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await store.update(task.id, { status: "active" });
    await expect(store.update(task.id, { artifact_refs: null })).rejects.toThrow(/can be cleared or replaced only while task is triaged/);
    await store.update(task.id, { status: "triaged", artifact_refs: null });
    expect(store.get(task.id).artifact_refs).toBeUndefined();
  });

  it("works without SDD and surfaces missing refs as attention only", async () => {
    const task = await store.create({ title: "missing sdd", author: "human", artifact_refs: [{ type: "sdd", ref: "999-nope" }] });
    await store.update(task.id, { status: "triaged" });
    const view = store.getView(task.id);
    expect(view.task.status).toBe("triaged");
    expect(view.attention).toContainEqual(expect.objectContaining({ code: "missing_sdd_spec" }));
    expect(store.next("codex")).toMatchObject({ task: { id: task.id }, attention: [{ code: "missing_sdd_spec" }] });
  });

  it("validates artifact refs and priority/rank/kind bounds", async () => {
    await expect(store.create({ title: "x", author: "human", artifact_refs: [{ type: "url", ref: "https://x" }, { type: "url", ref: "https://x" }] })).rejects.toThrow(/duplicate/);
    await expect(store.create({ title: "x", author: "human", priority: 9 as never })).rejects.toThrow(/priority/);
    await expect(store.create({ title: "x", author: "human", rank: "" })).rejects.toThrow(/rank/);
  });

  // spec 339 — Task Studio's staged create transaction pre-mints an id (for the attachment namespace, bound
  // before the task exists) and asks TaskStore to use it verbatim rather than auto-minting a different one.
  it("creates with a caller-supplied id when given (spec 339 staged-create seam)", async () => {
    const task = await store.create({ id: "t-abc123", title: "from studio", author: "human" });
    expect(task.id).toBe("t-abc123");
    expect(store.get("t-abc123")).toMatchObject({ title: "from studio" });
  });

  it("rejects a malformed caller-supplied id and does not fall back to auto-mint", async () => {
    await expect(store.create({ id: "not-an-id", title: "x", author: "human" })).rejects.toThrow(/invalid task id/);
    expect(store.listRaw()).toEqual([]);
  });

  it("rejects a caller-supplied id that already exists rather than silently minting another", async () => {
    await store.create({ id: "t-abc123", title: "first", author: "human" });
    await expect(store.create({ id: "t-abc123", title: "second", author: "human" })).rejects.toThrow();
    expect(store.get("t-abc123").title).toBe("first");
  });
});

// spec 335 (Gated v1.1) — the reorder gesture's single-task write path: TaskStore.update rejects a same-lane
// rank collision (dueto F2, two concurrent drags racing the same midpoint) rather than silently overwriting.
describe("rank collision guard (Gated v1.1)", () => {
  it("rejects setting a rank that already belongs to another task in the SAME status/priority lane", async () => {
    const a = await store.create({ title: "a", author: "human", priority: 1 });
    const b = await store.create({ title: "b", author: "human", priority: 1 });
    await store.update(a.id, { status: "triaged", rank: "m" });
    await expect(store.update(b.id, { status: "triaged", rank: "m" })).rejects.toThrow(/precondition-failed: rank collision/);
  });

  it("allows the same literal rank string in a DIFFERENT lane (different priority)", async () => {
    const a = await store.create({ title: "a", author: "human", priority: 1 });
    const b = await store.create({ title: "b", author: "human", priority: 2 });
    await store.update(a.id, { status: "triaged", rank: "m" });
    const updated = await store.update(b.id, { status: "triaged", rank: "m" });
    expect(updated.rank).toBe("m");
  });

  it("allows the same literal rank string in a DIFFERENT status", async () => {
    const a = await store.create({ title: "a", author: "human", priority: 1 });
    const b = await store.create({ title: "b", author: "human", priority: 1 });
    await store.update(a.id, { status: "triaged", rank: "m" });
    await store.update(b.id, { status: "triaged" });
    const updated = await store.update(b.id, { status: "active", assignee: "codex", rank: "m" });
    expect(updated.rank).toBe("m");
  });

  it("clearing a rank (rank:null, the priority quick-edit path, dueto F5) never triggers the collision guard", async () => {
    const a = await store.create({ title: "a", author: "human", priority: 1 });
    await store.update(a.id, { status: "triaged", rank: "m" });
    const cleared = await store.update(a.id, { priority: 2, rank: null });
    expect(cleared.rank).toBeUndefined();
  });
});

// spec 335 (Gated v1.1) — TaskStore.reorderLane: the store-owned rebalance the board falls back to when
// between() finds no midpoint. Atomic under the mutation lock; CAS across the WHOLE lane, no partial writes.
describe("reorderLane (Gated v1.1)", () => {
  it("rewrites the lane's ranks in the requested order, evenly spaced", async () => {
    const a = await store.create({ title: "a", author: "human", priority: 1 });
    const b = await store.create({ title: "b", author: "human", priority: 1 });
    const c = await store.create({ title: "c", author: "human", priority: 1 });
    for (const t of [a, b, c]) await store.update(t.id, { status: "triaged" });
    const fresh = [store.get(a.id), store.get(b.id), store.get(c.id)];
    const expect_ = Object.fromEntries(fresh.map((t) => [t.id, t.updatedAt]));

    const rewritten = await store.reorderLane("triaged", 1, { orderedIds: [c.id, a.id, b.id], expect: expect_ });
    expect(rewritten.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    const ranks = rewritten.map((t) => t.rank!);
    expect(ranks[0]! < ranks[1]!).toBe(true);
    expect(ranks[1]! < ranks[2]!).toBe(true);
    // persisted, not just returned
    expect(store.get(c.id).rank).toBe(ranks[0]);
    expect(store.get(a.id).rank).toBe(ranks[1]);
    expect(store.get(b.id).rank).toBe(ranks[2]);
  });

  it("rejects fail-closed (no writes at all) when ANY task in the lane has a stale updatedAt (partial-write prevention)", async () => {
    const a = await store.create({ title: "a", author: "human", priority: 1 });
    const b = await store.create({ title: "b", author: "human", priority: 1 });
    await store.update(a.id, { status: "triaged" });
    await store.update(b.id, { status: "triaged" });
    const staleExpect = { [a.id]: store.get(a.id).updatedAt, [b.id]: "2000-01-01T00:00:00.000Z" }; // b's is wrong
    const beforeA = store.get(a.id);
    const beforeB = store.get(b.id);

    await expect(store.reorderLane("triaged", 1, { orderedIds: [b.id, a.id], expect: staleExpect })).rejects.toThrow(/precondition-failed/);
    expect(store.get(a.id)).toEqual(beforeA); // untouched — no partial write
    expect(store.get(b.id)).toEqual(beforeB);
  });

  it("rejects fail-closed when lane membership changed underneath (a task left or joined the lane mid-drag)", async () => {
    const a = await store.create({ title: "a", author: "human", priority: 1 });
    const b = await store.create({ title: "b", author: "human", priority: 1 });
    await store.update(a.id, { status: "triaged" });
    await store.update(b.id, { status: "triaged" });
    const staleSnapshotExpect = { [a.id]: store.get(a.id).updatedAt, [b.id]: store.get(b.id).updatedAt };
    // b moved out of the lane after the board took its snapshot
    await store.update(b.id, { status: "active", assignee: "codex" });
    const beforeA = store.get(a.id);

    await expect(store.reorderLane("triaged", 1, { orderedIds: [b.id, a.id], expect: staleSnapshotExpect })).rejects.toThrow(/lane membership changed/);
    expect(store.get(a.id)).toEqual(beforeA);
  });

  it("treats undefined priority as its own lane, distinct from any numbered priority", async () => {
    const a = await store.create({ title: "a", author: "human" }); // no priority
    const b = await store.create({ title: "b", author: "human", priority: 1 });
    await store.update(a.id, { status: "triaged" });
    await store.update(b.id, { status: "triaged" });
    const expect_ = { [a.id]: store.get(a.id).updatedAt };
    const rewritten = await store.reorderLane("triaged", undefined, { orderedIds: [a.id], expect: expect_ });
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]!.id).toBe(a.id);
  });
});

// spec 335 (T3/T4 verification line) — allowedTransitions is what the Mission Control board reads for drag
// affordances; this is the parity proof that its answer matches what assertTransition actually enforces, for
// EVERY status pair (not just the ones the acceptance-scenario tests above happen to exercise).
describe("allowedTransitions parity with assertTransition", () => {
  it("agrees with the store's actual accept/reject for every (from, to) status pair", async () => {
    let counter = 0;
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (from === to) continue;
        const id = `t-${(counter++).toString(16).padStart(6, "0")}`;
        const raw = { id, title: `${from}->${to}`, status: from, author: "human", assignee: "codex", createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" };
        fs.mkdirSync(path.join(root, ".tachyon", "tasks"), { recursive: true });
        fs.writeFileSync(path.join(root, ".tachyon", "tasks", `${id}.json`), JSON.stringify(raw), "utf8");
        const fresh = new TaskStore(root);

        const expectAllowed = allowedTransitions(from).includes(to);
        const outcome = await fresh.update(id, { status: to }).then(() => true, () => false);
        expect(outcome, `${from} -> ${to}`).toBe(expectAllowed);
      }
    }
  });
});
