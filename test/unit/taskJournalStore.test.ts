import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sliceJournal, TaskJournalStore } from "@tachyon/engine/tasks/TaskJournalStore.js";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import type { JournalEntry } from "@tachyon/shared/tasks/types.js";

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
    // t-f33480 — status moves leave an automatic journal trail; post-hoc notes still append.
    // Order, not merely membership: this used to say "same-millisecond entries can sort by id",
    // which was the t-c89c52 defect written down as if it were a property. Both of these DO land in
    // the same millisecond, so asserting append order here is the cheapest guard against it.
    expect(tasks.journal.read(dropped.id).map((e) => e.text)).toEqual(
      ["status inbox -> dropped", "post hoc dropped note"],
    );

    const reopen = await tasks.create({ title: "reopen", author: "human" });
    await tasks.update(reopen.id, { status: "triaged" });
    tasks.journal.append(reopen.id, { author: "codex", text: "survives reopen" });
    await tasks.update(reopen.id, { status: "inbox" });
    expect(tasks.get(reopen.id).status).toBe("inbox");
    expect(tasks.journal.read(reopen.id).map((e) => e.text)).toEqual([
      "status inbox -> triaged",
      "survives reopen",
      "status triaged -> inbox",
    ]);
  });
});

/**
 * t-c89c52 — the journal is append-only and its WRITE ORDER is the information. `read()` used to
 * order by `ts` and break ties with `a.id.localeCompare(b.id)`, but the id is
 * `j-${crypto.randomBytes(6)}` — so two entries written in the same millisecond came back in a
 * RANDOM order. Measured before the fix, with two same-millisecond appends over 200 trials: append
 * order survived 100 times. An exact coin flip.
 *
 * `ts` has millisecond resolution and a burst from ONE operation is precisely what lands inside a
 * single millisecond, so this was not a rare race. It surfaced as `taskStore.test.ts` reading
 * `.at(-1)` and getting the previous entry, and it reaches every consumer that asks "what happened
 * last" — the notification policy, the detail projection, the UI.
 *
 * The fix keeps the on-disk format untouched (changing a persisted id or `ts` format is a bigger
 * risk than the defect) and tie-breaks on the order the lines already have in the file. That order
 * is the append order, and it was being thrown away by the sort.
 *
 * Each `it` below is one ACTOR × TRIGGER that can reach the same read.
 */
describe("journal read order (t-c89c52)", () => {
  const SAME_MS = "2026-07-04T00:00:01.000Z";

  it("a burst from one operation reads back in append order", () => {
    const journal = new TaskJournalStore(root);
    const id = "t-aaaaaa";
    const written = Array.from({ length: 8 }, (_, i) => `burst ${i}`);
    for (const text of written) journal.append(id, { author: "codex", text, now: SAME_MS });

    // Before the fix this passed only when 8 random ids happened to sort into append order: 1 in 8!.
    expect(journal.read(id).map((e) => e.text)).toEqual(written);
  });

  it("appends from separate writers in the same millisecond keep the order the file has", () => {
    const id = "t-bbbbbb";
    // Two store instances are the second writer door — the same one two PROCESSES take, since each
    // append is an O_APPEND write and the file is the only shared state.
    const a = new TaskJournalStore(root);
    const b = new TaskJournalStore(root);
    a.append(id, { author: "agent-a", text: "from A, first", now: SAME_MS });
    b.append(id, { author: "agent-b", text: "from B, second", now: SAME_MS });
    a.append(id, { author: "agent-a", text: "from A, third", now: SAME_MS });

    expect(new TaskJournalStore(root).read(id).map((e) => e.text)).toEqual([
      "from A, first",
      "from B, second",
      "from A, third",
    ]);
  });

  it("a journal already on disk, written with random ids before the fix, reads in file order", () => {
    const id = "t-cccccc";
    const dir = path.join(root, ".tachyon", "tasks");
    fs.mkdirSync(dir, { recursive: true });
    // Ids deliberately DESCENDING lexically, which is what the old tie-break would have sorted on:
    // if file order wins, these come back as written; if id order wins, they come back reversed.
    const lines = [
      { id: "j-ffffffffffff", ts: SAME_MS, author: "codex", text: "written first" },
      { id: "j-aaaaaaaaaaaa", ts: SAME_MS, author: "codex", text: "written second" },
    ];
    fs.writeFileSync(path.join(dir, `${id}.journal`), lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");

    expect(new TaskJournalStore(root).read(id).map((e) => e.text)).toEqual(["written first", "written second"]);
    // and the entries themselves are untouched — this fix reorders reads, it does not rewrite history.
    expect(new TaskJournalStore(root).read(id).map((e) => e.id)).toEqual(["j-ffffffffffff", "j-aaaaaaaaaaaa"]);
  });

  it("still orders by ts when the timestamps differ, whatever order the lines are in", () => {
    const id = "t-dddddd";
    const dir = path.join(root, ".tachyon", "tasks");
    fs.mkdirSync(dir, { recursive: true });
    // File order is NOT the answer here: a backdated entry appended late still belongs earlier.
    const lines = [
      { id: "j-000000000001", ts: "2026-07-04T00:00:09.000Z", author: "codex", text: "later" },
      { id: "j-000000000002", ts: "2026-07-04T00:00:02.000Z", author: "codex", text: "earlier" },
    ];
    fs.writeFileSync(path.join(dir, `${id}.journal`), lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");

    expect(new TaskJournalStore(root).read(id).map((e) => e.text)).toEqual(["earlier", "later"]);
  });
});

/**
 * t-ab7708 — the journal used to enter `get_task` whole and uncapped, 66.6% of the tool's measured
 * cost. These pin the window that replaced it: what it keeps, and that it always says what it dropped.
 */
describe("sliceJournal", () => {
  const entry = (n: number, chars: number): JournalEntry => ({
    id: `j-${String(n).padStart(12, "0")}`,
    ts: `2026-07-04T00:00:${String(n).padStart(2, "0")}.000Z`,
    author: "codex",
    text: "x".repeat(chars),
  });
  const bytes = (entries: JournalEntry[]) => entries.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), "utf8"), 0);

  it("cuts by BYTES and not by entry count: the same cap yields many small entries or few large ones", () => {
    const small = Array.from({ length: 40 }, (_, i) => entry(i, 20));
    const large = Array.from({ length: 40 }, (_, i) => entry(i, 900));

    const smallWindow = sliceJournal(small, { mode: "tail", maxBytes: 2000 });
    const largeWindow = sliceJournal(large, { mode: "tail", maxBytes: 2000 });

    // An entry-count cap would have returned the same number for both; a byte cap bounds the cost.
    expect(smallWindow.entries.length).toBeGreaterThan(largeWindow.entries.length * 5);
    expect(bytes(smallWindow.entries)).toBeLessThanOrEqual(2000);
    expect(bytes(largeWindow.entries)).toBeLessThanOrEqual(2000);
  });

  it("never splits an entry, and always returns whole entries from the newest end", () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i, 300));
    const { entries: kept, window } = sliceJournal(entries, { mode: "tail", maxBytes: 1000 });

    expect(kept.every((e) => e.text.length === 300)).toBe(true);
    expect(kept).toEqual(entries.slice(entries.length - kept.length));
    expect(window).toMatchObject({ mode: "tail", returned: kept.length, total: 10, offset: 10 - kept.length, truncated: true });
  });

  it("returns a single over-budget entry rather than an empty window, and still declares the truncation", () => {
    const entries = [entry(0, 50), entry(1, 5000)];
    const { entries: kept, window } = sliceJournal(entries, { mode: "tail", maxBytes: 1000 });

    expect(kept).toHaveLength(1);
    expect(kept[0].text).toHaveLength(5000);
    expect(bytes(kept)).toBeGreaterThan(1000);
    expect(window).toMatchObject({ returned: 1, total: 2, truncated: true });
    expect(window.note).toContain('journal="all"');
  });

  it("declares total and returned even when nothing was withheld, and adds no note", () => {
    const { entries: kept, window } = sliceJournal([entry(0, 10), entry(1, 10)], { mode: "tail", maxBytes: 4096 });

    expect(kept).toHaveLength(2);
    expect(window).toMatchObject({ mode: "tail", returned: 2, total: 2, offset: 0, truncated: false });
    expect(window.note).toBeUndefined();
  });

  it("a truncated tail names the escape hatch; a forward page names the next offset", () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry(i, 400));

    const tail = sliceJournal(entries, { mode: "tail", maxBytes: 1200 });
    expect(tail.window.note).toMatch(/showing entr(y|ies) \d+-12 of 12 \(the most recent, maxBytes=1200\)/);
    expect(tail.window.note).toContain('journal="all"');
    expect(tail.window.note).toContain("journalOffset=0");

    const page = sliceJournal(entries, { mode: "tail", offset: 0, maxBytes: 1200 });
    expect(page.window).toMatchObject({ offset: 0, truncated: true });
    expect(page.entries[0]).toEqual(entries[0]);
    expect(page.window.note).toContain(`journalOffset=${page.window.returned}`);
  });

  it("pages the whole journal forward through offsets without ever asking for all of it", () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(i, 350));
    const walked: JournalEntry[] = [];
    let offset = 0;
    for (let guard = 0; guard < 50 && offset < entries.length; guard++) {
      const page = sliceJournal(entries, { mode: "tail", offset, maxBytes: 900 });
      expect(page.entries.length).toBeGreaterThan(0);
      walked.push(...page.entries);
      offset = page.window.offset + page.window.returned;
    }
    expect(walked).toEqual(entries);
  });

  it("an offset past the end answers empty and says so, in the molde of list_tasks", () => {
    const { entries: kept, window } = sliceJournal([entry(0, 10)], { mode: "tail", offset: 7 });

    expect(kept).toEqual([]);
    expect(window).toMatchObject({ returned: 0, total: 1, offset: 7, truncated: true });
    expect(window.note).toContain("journalOffset 7 is beyond the 1 entry");
  });

  it("'none' withholds every entry but never hides that it did; 'all' is uncapped", () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(i, 9000));

    const none = sliceJournal(entries, { mode: "none" });
    expect(none.entries).toEqual([]);
    expect(none.window).toMatchObject({ mode: "none", returned: 0, total: 6, truncated: true });
    expect(none.window.note).toContain("6 entries");

    const all = sliceJournal(entries, { mode: "all", maxBytes: 100 });
    expect(all.entries).toEqual(entries);
    expect(all.window).toMatchObject({ mode: "all", returned: 6, total: 6, truncated: false });
    expect(all.window.note).toBeUndefined();

    const emptyNone = sliceJournal([], { mode: "none" });
    expect(emptyNone.window).toMatchObject({ total: 0, truncated: false });
    expect(emptyNone.window.note).toBeUndefined();
  });
});

describe("TaskStore.getView journal windows", () => {
  it("windows for a token-paying reader, and still materializes the whole log for Task Detail", async () => {
    const tasks = new TaskStore(root);
    const task = await tasks.create({ title: "windowed", author: "human" });
    for (let i = 0; i < 12; i++) {
      tasks.journal.append(task.id, { author: "codex", text: `${i} ${"y".repeat(600)}`, now: `2026-07-04T00:00:${String(i).padStart(2, "0")}.000Z` });
    }

    const windowed = tasks.getView(task.id, { journalWindow: { mode: "tail", maxBytes: 1500 } });
    expect(windowed.journal!.length).toBeLessThan(12);
    expect(windowed.journalCount).toBe(12);
    expect(windowed.journalWindow).toMatchObject({ total: 12, truncated: true });

    // Task Detail reads through includeJournal and is unchanged: no window, no cap.
    const whole = tasks.getView(task.id, { includeJournal: true });
    expect(whole.journal).toHaveLength(12);
    expect(whole.journalWindow).toBeUndefined();
    expect(whole.journalCount).toBe(12);

    // journal:"none" still costs the caller the count, which is the cheap thing they came for.
    const stateOnly = tasks.getView(task.id, { journalWindow: { mode: "none" } });
    expect(stateOnly.journal).toEqual([]);
    expect(stateOnly.journalCount).toBe(12);
    expect(stateOnly.journalWindow).toMatchObject({ mode: "none", total: 12, truncated: true });
  });
});
