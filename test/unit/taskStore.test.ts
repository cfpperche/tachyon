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
    expect(view.attention).toContainEqual(expect.objectContaining({ code: "ready_to_close" }));
    expect(store.next("codex")).toEqual({ empty: true, reason: "no-tasks" });
    await store.update(task.id, { status: "done" });
    expect(store.get(task.id).status).toBe("done");
  });

  it("fails closed when SDD artifact refs are cleared while marking done", async () => {
    writeSpec("326-sdd-plugin", "in-progress");
    const task = await store.create({ title: "sdd", author: "human", artifact_refs: [{ type: "sdd", ref: "326-sdd-plugin" }] });
    await store.update(task.id, { status: "triaged", assignee: "codex" });
    await store.update(task.id, { status: "active" });
    await expect(store.update(task.id, { status: "done", artifact_refs: null })).rejects.toThrow(/can be cleared or replaced only while task is triaged/);
    expect(store.get(task.id).artifact_refs).toEqual([{ type: "sdd", ref: "326-sdd-plugin" }]);
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
