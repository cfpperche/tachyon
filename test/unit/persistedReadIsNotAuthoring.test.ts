/**
 * t-c2882f — reading a persisted record must never be more restrictive than writing one.
 *
 * Three real tasks (t-1d9d15, t-a27293, t-d780e4) written in July 2026 with bodies of 11511, 6489 and
 * 4238 code points vanished from the board and answered `unknown task`, because the READ path
 * re-applied `TASK_AUTHORING_LIMITS.body`. Nothing was corrupt; the records were intact and simply out
 * of reach. Two consequences these tests pin, one per direction:
 *
 *   - a write cap must not govern the past: reading returns what is on disk, whole;
 *   - and the fix must not become a relaxation: the authoring door still refuses the same size.
 *
 * The `unknown task` message is pinned too. A refusal that disguises itself as an absence sends the
 * reader looking for a record that was never created instead of at the file that is right there.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { JOURNAL_TEXT_MAX_CODEPOINTS, TaskJournalStore } from "../../src/tasks/TaskJournalStore.js";
import { TASK_AUTHORING_LIMITS } from "../../src/tasks/taskAuthoring.js";
import { projectTaskDetail } from "../../src/runtime-api/taskDetailProjection.js";
import { projectTaskStudio } from "../../src/runtime-api/taskStudioProjection.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-persisted-read-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a task record straight to disk, exactly as an older Bridge would have left it. */
function persistTask(id: string, row: Record<string, unknown>): string {
  const dir = path.join(root, ".tachyon", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    id,
    title: "persisted before the current limit",
    status: "inbox",
    author: "claude",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...row,
  }, null, 2)}\n`, "utf8");
  return file;
}

describe("persisted reads are not authoring (t-c2882f)", () => {
  it("serves a task whose persisted body is over the authoring limit, whole and unedited", () => {
    const body = "B".repeat(11_511);
    persistTask("t-1d9d15", { body, kind: "bug" });
    const store = new TaskStore(root);

    const task = store.get("t-1d9d15");
    expect(task.body).toBe(body);
    expect(task.body?.length).toBe(11_511);
    expect(store.listRaw().map((t) => t.id)).toContain("t-1d9d15");
    expect(store.listViews(100).map((v) => v.task.id)).toContain("t-1d9d15");
    expect(store.count()).toBe(1);
    expect(store.count({ status: "inbox" })).toBe(1);
  });

  it("still refuses to AUTHOR a body of the same size, through create and through update", async () => {
    const store = new TaskStore(root);
    const oversize = "B".repeat(TASK_AUTHORING_LIMITS.body + 1);

    await expect(store.create({ title: "author it", author: "claude", body: oversize }))
      .rejects.toThrow(`create_task body received ${TASK_AUTHORING_LIMITS.body + 1} code points; maximum ${TASK_AUTHORING_LIMITS.body}`);

    const task = await store.create({ title: "author it", author: "claude" });
    await expect(store.update(task.id, { body: oversize }))
      .rejects.toThrow(`create_task body received ${TASK_AUTHORING_LIMITS.body + 1} code points; maximum ${TASK_AUTHORING_LIMITS.body}`);
    expect(store.get(task.id).body).toBeUndefined();
  });

  it("applies the same split to title, kind and artifact_refs — read returns, write refuses", async () => {
    const title = "T".repeat(TASK_AUTHORING_LIMITS.title + 1);
    const kind = "k".repeat(TASK_AUTHORING_LIMITS.kind + 1);
    const refs = Array.from({ length: TASK_AUTHORING_LIMITS.artifactRefs + 4 }, (_, i) => ({ type: "file", ref: `docs/${i}.md` }));
    persistTask("t-a27293", { title, kind, artifact_refs: refs, deps: ["t-60979d"] });
    const store = new TaskStore(root);

    const task = store.get("t-a27293");
    expect(task.title).toBe(title);
    expect(task.kind).toBe(kind);
    expect(task.artifact_refs).toHaveLength(TASK_AUTHORING_LIMITS.artifactRefs + 4);
    expect(task.deps).toEqual(["t-60979d"]);

    await expect(store.create({ title, author: "claude" }))
      .rejects.toThrow(`create_task title received ${TASK_AUTHORING_LIMITS.title + 1} code points`);
    await expect(store.create({ title: "ok", author: "claude", kind }))
      .rejects.toThrow(`create_task kind received ${TASK_AUTHORING_LIMITS.kind + 1} code points`);
    await expect(store.create({ title: "ok", author: "claude", artifact_refs: refs }))
      .rejects.toThrow(`create_task artifact_refs received ${refs.length} entries; maximum ${TASK_AUTHORING_LIMITS.artifactRefs}`);
  });

  /**
   * The store was only the first door. The HUMAN reaches the same records through the webview
   * projections, which re-encoded the same authoring numbers in their wire schemas — so all three
   * tasks still threw `expected 1-4000 code points` on the way to Task Detail with the store already
   * fixed. Measured, not assumed. Same actor-times-trigger question the repo guidance asks.
   */
  it("carries an oversize record through the Task Detail projection", () => {
    const body = "B".repeat(11_511);
    persistTask("t-1d9d15", {
      body,
      kind: "k".repeat(TASK_AUTHORING_LIMITS.kind + 1),
      title: "T".repeat(TASK_AUTHORING_LIMITS.title + 1),
      artifact_refs: Array.from({ length: TASK_AUTHORING_LIMITS.artifactRefs + 2 }, (_, i) => ({ type: "file", ref: `docs/${i}.md` })),
    });

    const detail = projectTaskDetail(new TaskStore(root), root, "t-1d9d15");
    expect(detail.task.body).toBe(body);
    expect(detail.task.title).toHaveLength(TASK_AUTHORING_LIMITS.title + 1);
    expect(detail.task.artifact_refs).toHaveLength(TASK_AUTHORING_LIMITS.artifactRefs + 2);
  });

  it("carries an oversize record through the Task Studio projection", () => {
    const body = "B".repeat(11_511);
    persistTask("t-1d9d15", { body, kind: "bug" });

    const studio = projectTaskStudio(new TaskStore(root), root, "t-1d9d15");
    expect(studio.bodyBaseline).toBe(body);
    expect(studio.taskId).toBe("t-1d9d15");
  });

  it("names a task that exists but cannot be served, instead of calling it unknown", () => {
    const file = persistTask("t-d780e4", { status: "nonsense-status" });
    const store = new TaskStore(root);

    let message = "";
    try {
      store.get("t-d780e4");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("t-d780e4");
    expect(message).toContain(file);
    expect(message).toContain("status");
    expect(message).not.toContain("unknown task");

    // A record that genuinely is not there keeps saying so — the honest half of the same answer.
    expect(() => store.get("t-ffffff")).toThrow("unknown task 't-ffffff'");
    expect(store.listRaw()).toEqual([]);
  });

  it("serves journal entries persisted above the append cap, and still refuses to append one", () => {
    const journal = new TaskJournalStore(root);
    fs.mkdirSync(journal.dir, { recursive: true });
    const text = "J".repeat(JOURNAL_TEXT_MAX_CODEPOINTS + 500);
    fs.writeFileSync(
      journal.pathFor("t-1d9d15"),
      `${JSON.stringify({ id: "j-0123456789ab", ts: "2026-07-09T00:00:00.000Z", author: "claude", text })}\n`,
      "utf8",
    );

    const entries = journal.read("t-1d9d15");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe(text);
    expect(journal.count("t-1d9d15")).toBe(1);

    expect(() => journal.append("t-1d9d15", { author: "claude", text })).toThrow(/text/);
  });

  it("serves a validation persisted above its authoring caps, and still refuses to author one", async () => {
    const dir = path.join(root, ".tachyon", "validations");
    fs.mkdirSync(dir, { recursive: true });
    const instructions = "I".repeat(4_500);
    fs.writeFileSync(path.join(dir, "v-abc123.json"), `${JSON.stringify({
      id: "v-abc123",
      title: "persisted before the current limit",
      status: "pending",
      executor: "human",
      rounds: [],
      instructions,
      author: "claude",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    }, null, 2)}\n`, "utf8");
    const store = new ValidationStore(root);

    expect(store.get("v-abc123").instructions).toBe(instructions);
    expect(store.list().map((v) => v.id)).toEqual(["v-abc123"]);

    await expect(store.create({ title: "author it", author: "claude", instructions }))
      .rejects.toThrow(/instructions/);
  });
});
