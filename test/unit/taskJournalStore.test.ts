import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskJournalStore } from "../../src/tasks/TaskJournalStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-task-journal-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskJournalStore", () => {
  it("appends newline JSON entries to the per-task .journal file and never writes notes into the task JSON", async () => {
    const tasks = new TaskStore(root);
    const task = await tasks.create({ title: "journal fixture", author: "human", now: "2026-07-04T00:00:00.000Z" });
    const entry = tasks.journal.append(task.id, { author: "codex", text: "first note", now: "2026-07-04T00:00:01.000Z" });

    expect(entry).toMatchObject({ author: "codex", text: "first note", ts: "2026-07-04T00:00:01.000Z" });
    const journalPath = path.join(root, ".tachyon", "tasks", `${task.id}.journal`);
    expect(fs.readFileSync(journalPath, "utf8").trim()).toContain("first note");
    const taskJson = fs.readFileSync(tasks.pathFor(task.id), "utf8");
    expect(taskJson).not.toContain("first note");
    expect(JSON.parse(taskJson).journal).toBeUndefined();
    expect(JSON.parse(taskJson).notes).toBeUndefined();
  });

  it("two independent store instances append without clobbering each other", async () => {
    const tasks = new TaskStore(root);
    const task = await tasks.create({ title: "concurrency", author: "human" });
    const a = new TaskJournalStore(root);
    const b = new TaskJournalStore(root);

    await Promise.all([
      Promise.resolve().then(() => a.append(task.id, { author: "agent-a", text: "append from A" })),
      Promise.resolve().then(() => b.append(task.id, { author: "agent-b", text: "append from B" })),
    ]);

    expect(new TaskJournalStore(root).read(task.id).map((e) => e.text).sort()).toEqual(["append from A", "append from B"]);
  });

  it("a body update racing a journal append preserves both because they touch different files", async () => {
    const writerA = new TaskStore(root);
    const task = await writerA.create({ title: "mixed writes", author: "human", body: "old" });
    const writerB = new TaskStore(root);

    await Promise.all([
      writerA.update(task.id, { body: "new body" }),
      Promise.resolve().then(() => writerB.journal.append(task.id, { author: "codex", text: "kept note" })),
    ]);

    const fresh = new TaskStore(root);
    expect(fresh.get(task.id).body).toBe("new body");
    expect(fresh.journal.read(task.id).map((e) => e.text)).toEqual(["kept note"]);
  });

  it("skips a torn final line while materializing", async () => {
    const tasks = new TaskStore(root);
    const task = await tasks.create({ title: "torn", author: "human" });
    tasks.journal.append(task.id, { author: "codex", text: "complete" });
    fs.appendFileSync(tasks.journal.pathFor(task.id), "{\"id\":\"j-torn\"", "utf8");

    expect(tasks.journal.read(task.id).map((e) => e.text)).toEqual(["complete"]);
  });

  it("rejects per-entry and retained-size cap overflow without pruning existing entries", async () => {
    const tasks = new TaskStore(root);
    const task = await tasks.create({ title: "cap", author: "human" });
    const capped = new TaskJournalStore(root, { maxTextCodePoints: 8, maxBytes: 130 });

    expect(() => capped.append(task.id, { author: "codex", text: "too many chars" })).toThrow(/text must be at most 8/);
    capped.append(task.id, { author: "codex", text: "one" });
    expect(() => capped.append(task.id, { author: "codex", text: "two" })).toThrow(/JOURNAL_CAP_EXCEEDED/);
    expect(capped.read(task.id).map((e) => e.text)).toEqual(["one"]);
  });

  it("allows appends on done/dropped tasks and survives triaged to inbox reopen without changing updatedAt", async () => {
    const tasks = new TaskStore(root);
    const done = await tasks.create({ title: "done note", author: "human", now: "2026-07-04T00:00:00.000Z" });
    await tasks.update(done.id, { status: "triaged", assignee: "codex", now: "2026-07-04T00:00:01.000Z" });
    await tasks.update(done.id, { status: "active", now: "2026-07-04T00:00:02.000Z" });
    await tasks.update(done.id, { status: "done", now: "2026-07-04T00:00:03.000Z" });
    const beforeDoneNote = tasks.get(done.id).updatedAt;
    tasks.journal.append(done.id, { author: "codex", text: "post hoc done note" });
    expect(tasks.get(done.id).updatedAt).toBe(beforeDoneNote);

    const dropped = await tasks.create({ title: "dropped note", author: "human" });
    await tasks.update(dropped.id, { status: "dropped" });
    tasks.journal.append(dropped.id, { author: "codex", text: "post hoc dropped note" });
    expect(tasks.journal.read(dropped.id).map((e) => e.text)).toEqual(["post hoc dropped note"]);

    const reopen = await tasks.create({ title: "reopen", author: "human" });
    await tasks.update(reopen.id, { status: "triaged" });
    tasks.journal.append(reopen.id, { author: "codex", text: "survives reopen" });
    await tasks.update(reopen.id, { status: "inbox" });
    expect(tasks.get(reopen.id).status).toBe("inbox");
    expect(tasks.journal.read(reopen.id).map((e) => e.text)).toEqual(["survives reopen"]);
  });
});
