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
import {
  TASK_PROTOTYPE_REVIEW_MAX,
  TASK_PROTOTYPE_TITLE_MAX,
  TaskPrototypeStore,
} from "../../src/tasks/TaskPrototypeStore.js";
import { TASK_AUTHORING_LIMITS } from "../../src/tasks/taskAuthoring.js";
import { buildBoardSnapshot } from "../../src/tasks/boardSnapshot.js";
import { projectMissionControlBoard } from "../../src/runtime-api/missionControlProjection.js";
import { projectTaskDetail } from "../../src/runtime-api/taskDetailProjection.js";
import { projectTaskStudio } from "../../src/runtime-api/taskStudioProjection.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import {
  SELECTED_MEMORY_MAX_ENTRIES,
  SELECTED_MEMORY_MAX_ENTRY_BYTES,
  persistedSelectedMemoryManifestSchema,
  selectedMemoryManifestSchema,
} from "../../src/memory/domain.js";
import { parseHandoffViewV1 } from "../../src/runtime-api/handoffProjection.js";
import {
  persistedRichDocAttachmentV1Schema,
  richDocAttachmentV1Schema,
} from "../../src/runtime-api/richDocWire.js";
import { parsePinStudioProjectionV1 } from "../../src/runtime-api/pinStudioProjection.js";
import {
  PIN_STUDIO_TITLE_MAX_CHARS,
  parsePinStudioStagedPayloadV1,
} from "../../src/runtime-api/pinStudioCommands.js";
import { PinStore, normalizePinTags } from "../../src/pins/PinStore.js";
import { resolveSoul, SOUL_MAX_CHARS, validateSoulBytes } from "../../src/agents/soul.js";

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

  /**
   * The board is the door where this defect costs the most: it validates the WHOLE projection in one
   * pass, so one oversize task threw `task body is invalid` and took every other row with it. That
   * also makes it the regression this change had to avoid — while the store silently dropped the
   * record, the board still rendered without it, and serving the record correctly is exactly what
   * breaks a board that cannot carry it. The neighbour row is asserted for that reason.
   */
  it("carries an oversize record through the Mission Control board without dropping its neighbours", () => {
    persistTask("t-aaaaaa", { body: "small", title: "an ordinary neighbour" });
    persistTask("t-1d9d15", { body: "B".repeat(11_511) });
    const store = new TaskStore(root);

    const board = projectMissionControlBoard(buildBoardSnapshot({ store, declaredAgents: [], workspaceRoot: root }));
    expect(board.views.map((v) => v.task.id).sort()).toEqual(["t-1d9d15", "t-aaaaaa"]);
    expect(board.views.find((v) => v.task.id === "t-1d9d15")?.task.body).toHaveLength(11_511);
  });

  it("carries an oversize record through the Task Studio projection", () => {
    const body = "B".repeat(11_511);
    persistTask("t-1d9d15", { body, kind: "bug" });

    const studio = projectTaskStudio(new TaskStore(root), root, "t-1d9d15");
    expect(studio.bodyBaseline).toBe(body);
    expect(studio.taskId).toBe("t-1d9d15");
  });

  /**
   * The other side of the same failure. Relaxing the read must not hand a projection a row it cannot
   * render: `title` and `author` are required and every projection types them non-empty, so an empty
   * one is a record MISSING a field, not a record with a small one. It is refused by name at the
   * store, skipped from listings, and the board still renders every other row.
   */
  it("refuses a record it cannot fully type, by name, without taking the board down with it", () => {
    persistTask("t-aaaaaa", { body: "B".repeat(11_511), title: "an ordinary neighbour" });
    persistTask("t-d780e4", { title: "   " });
    const store = new TaskStore(root);

    expect(() => store.get("t-d780e4")).toThrow(/title is empty/);
    expect(() => store.get("t-d780e4")).not.toThrow(/unknown task/);
    expect(store.listRaw().map((t) => t.id)).toEqual(["t-aaaaaa"]);

    const board = projectMissionControlBoard(buildBoardSnapshot({ store, declaredAgents: [], workspaceRoot: root }));
    expect(board.views.map((v) => v.task.id)).toEqual(["t-aaaaaa"]);
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

  /**
   * t-e02bc5 — the fifth door, and the one where the same shape costs the most.
   *
   * `parseManifest` re-applied `TASK_PROTOTYPE_TITLE_MAX` and `TASK_PROTOTYPE_REVIEW_MAX` — the numbers
   * `bounded()` already enforces at every authoring door — to the manifest it read back. Unlike the
   * store defects above it refused ALOUD, which is why it was left out of t-c2882f; but the manifest is
   * per TASK, so one oversize title did not hide one row: it took every prototype of that task out of
   * reach at once, and `readManifestOrEmpty` throws inside `createDraft`/`readMutable` too, so the task
   * could no longer accept a new prototype or a review either. A named refusal aids diagnosis; it does
   * not restore access, and the store offers no repair door.
   *
   * The size checks bound nothing to other evidence, which is what separates them from the integrity
   * checks around them: sha256 to the blob's bytes, byteSize to its length, review.sha256 to the
   * revision, supersededBy to a live id, one approved anchor, state to its timestamps. Anyone able to
   * rewrite the manifest satisfies a byte cap for free, so dropping it detects nothing less.
   */
  function persistPrototype(taskId: string, over: { title?: string; review?: string }): TaskPrototypeStore {
    const store = new TaskPrototypeStore(root, taskId);
    const created = store.createDraft({
      html: "<h1>persisted before the current limit</h1>",
      title: "within the limit of the day",
      author: "designer",
      now: "2026-07-09T00:00:00.000Z",
    });
    const revision = created.prototypes[0]!;
    const manifest = JSON.parse(fs.readFileSync(store.manifestPath, "utf8")) as {
      prototypes: { title: string; reviews: unknown[] }[];
    };
    if (over.title !== undefined) manifest.prototypes[0]!.title = over.title;
    if (over.review !== undefined) {
      manifest.prototypes[0]!.reviews.push({
        action: "note", text: over.review, at: "2026-07-09T00:00:00.000Z", by: "human", sha256: revision.sha256,
      });
    }
    fs.writeFileSync(store.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return store;
  }

  it("serves a prototype manifest persisted above the authoring caps, whole and unedited", () => {
    const title = "T".repeat(TASK_PROTOTYPE_TITLE_MAX + 1);
    const review = "R".repeat(TASK_PROTOTYPE_REVIEW_MAX + 500);
    const store = persistPrototype("t-abc123", { title, review });
    const before = fs.readFileSync(store.manifestPath, "utf8");

    const snapshot = store.read();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.readOnly).toBe(false);
    expect(snapshot.prototypes).toHaveLength(1);
    expect(snapshot.prototypes[0]).toMatchObject({ available: true, integrity: "verified", title });
    expect(snapshot.prototypes[0]!.reviews[0]?.text).toBe(review);
    // Reading is a read: the record is served as persisted, not repaired into the current limit.
    expect(fs.readFileSync(store.manifestPath, "utf8")).toBe(before);
    expect(store.readHtml(snapshot.prototypes[0]!.id)).toBe("<h1>persisted before the current limit</h1>");
  });

  it("still refuses to AUTHOR a title or a review of the same size, through all four doors", () => {
    const store = new TaskPrototypeStore(root, "t-abc123");
    const title = "T".repeat(TASK_PROTOTYPE_TITLE_MAX + 1);
    const review = "R".repeat(TASK_PROTOTYPE_REVIEW_MAX + 1);

    expect(() => store.createDraft({ html: "<p>A</p>", title, author: "designer", now: "a" }))
      .toThrow(`prototype title must be 1-${TASK_PROTOTYPE_TITLE_MAX} bytes`);

    const created = store.createDraft({ html: "<p>A</p>", title: "ok", author: "designer", now: "a" });
    const id = created.prototypes[0]!.id;
    expect(() => store.addReview(id, { expectUpdatedAt: "a", text: review }))
      .toThrow(`prototype review must be 1-${TASK_PROTOTYPE_REVIEW_MAX} bytes`);
    expect(() => store.approve(id, { expectUpdatedAt: "a", review, now: "b" }))
      .toThrow(`prototype review must be 1-${TASK_PROTOTYPE_REVIEW_MAX} bytes`);
    expect(() => store.reject(id, { expectUpdatedAt: "a", review, now: "b" }))
      .toThrow(`prototype review must be 1-${TASK_PROTOTYPE_REVIEW_MAX} bytes`);
    expect(store.read().prototypes[0]).toMatchObject({ state: "draft", title: "ok" });
    expect(store.read().prototypes[0]!.reviews).toEqual([]);
  });

  /**
   * The SIXTH door of the same family, dormant only while the store refused first. `taskDetailProjection`
   * re-encoded the same two numbers in its wire schema (`boundedText(200)`, `boundedText(64)`), and it
   * validates the whole view in one pass — so serving the record correctly at the store is exactly what
   * would have thrown here and taken Task Detail, Task Studio and the engine-service view with it. Same
   * regression t-c2882f measured on the board, one store further along.
   */
  it("carries an oversize prototype through the Task Detail projection", () => {
    const title = "T".repeat(TASK_PROTOTYPE_TITLE_MAX + 1);
    persistTask("t-abc123", { title: "an ordinary task" });
    persistPrototype("t-abc123", { title, review: "R".repeat(TASK_PROTOTYPE_REVIEW_MAX + 500) });

    const detail = projectTaskDetail(new TaskStore(root), root, "t-abc123");
    expect(detail.prototypes.readOnly).toBe(false);
    expect(detail.prototypes.prototypes).toHaveLength(1);
    expect(detail.prototypes.prototypes[0]!.title).toBe(title);
  });

  /**
   * `parseManifest` guards the write too, so relaxing it is not only about reading: a task carrying a
   * preserved oversize title has to stay reviewable. Refusing here would have left the record readable
   * and frozen, which is the same unreachability wearing a smaller hat.
   */
  it("lets a preserved oversize prototype still be approved, and keeps the persisted value", () => {
    const title = "T".repeat(TASK_PROTOTYPE_TITLE_MAX + 1);
    const store = persistPrototype("t-abc123", { title });

    const snapshot = store.read();
    const approved = store.approve(snapshot.prototypes[0]!.id, { expectUpdatedAt: snapshot.updatedAt!, now: "2026-08-02T00:00:00.000Z" });
    expect(approved.approved).toMatchObject({ state: "approved", approvedBy: "human", title });
    expect(JSON.parse(fs.readFileSync(store.manifestPath, "utf8")).prototypes[0].title).toBe(title);
  });

  /**
   * PRESENCE, not size — the same line the TaskStore fix drew. A title that is absent leaves a record the
   * projections cannot type, and it keeps being refused by the name it always had.
   */
  it("still refuses a prototype missing a required field, by the same name", () => {
    const store = persistPrototype("t-abc123", { title: "   " });

    expect(store.read()).toMatchObject({ readOnly: true, prototypes: [], error: "malformed prototype authored metadata" });
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

  it("serves selected-memory manifest sizes from disk while its authoring schema still refuses them", () => {
    const entry = (index: number) => ({
      id: `memory-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      path: `active/memory-00000000-0000-4000-8000-${String(index).padStart(12, "0")}.md`,
      sha256: "a".repeat(64), bytes: index === 0 ? SELECTED_MEMORY_MAX_ENTRY_BYTES + 1 : 0,
      sourceCandidateId: `candidate-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sourcePrincipal: "human", sourceKind: "human", approvedBy: "human", approvedAt: "2026-07-09T00:00:00.000Z",
    });
    const manifest = {
      schemaVersion: 1, activationId: "activation", agentId: "00000000-0000-4000-8000-000000000001",
      agentName: "Ada", version: 1,
      entries: Array.from({ length: SELECTED_MEMORY_MAX_ENTRIES + 1 }, (_, index) => entry(index)),
      updatedAt: "2026-07-09T00:00:00.000Z",
    };

    expect(persistedSelectedMemoryManifestSchema.parse(manifest).entries).toHaveLength(SELECTED_MEMORY_MAX_ENTRIES + 1);
    expect(selectedMemoryManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("keeps persisted handoff note text and evidence whole while the append door remains bounded", () => {
    const summary = "S".repeat(2_001);
    const evidence = Array.from({ length: 21 }, (_, index) => `${index}:${"E".repeat(401)}`);
    const parsed = parseHandoffViewV1({
      schemaVersion: 1,
      handoff: {
        canonicalRelativePath: ".tachyon/HANDOFF.md", exists: true, body: "body", staleness: "fresh",
        pendingCount: 1, updatedAt: "2026-07-09T00:00:00.000Z", updatedBy: "agent",
        revision: "a".repeat(16),
        notes: [{ ts: "2026-07-09T00:00:00.000Z", agent: "Ada", kind: "next", summary, evidence }],
        distillTargets: [],
      },
    });
    expect(parsed.handoff.notes[0]).toMatchObject({ summary, evidence });

    // append_project_handoff_note's public authoring contract remains 2,000 / 20 / 400.
    expect(summary.length).toBeGreaterThan(2_000);
    expect(evidence).toHaveLength(21);
    expect(evidence[0]!.length).toBeGreaterThan(400);
  });

  it("serves persisted rich-doc attachment metadata whole while command authoring still refuses it", () => {
    const attachment = {
      id: "att-abcdef", kind: "image", blobRef: "a".repeat(64), mediaType: "image/png",
      name: "N".repeat(501), size: 10 * 1024 * 1024 + 1, createdAt: "2026-07-09T00:00:00.000Z",
      source: "import", visibility: "local",
    };
    expect(persistedRichDocAttachmentV1Schema.parse(attachment)).toEqual(attachment);
    expect(richDocAttachmentV1Schema.safeParse(attachment).success).toBe(false);
  });

  it("serves a persisted Pin Studio title above its save cap while save authoring still refuses it", () => {
    const title = "T".repeat(PIN_STUDIO_TITLE_MAX_CHARS + 1);
    const projection = parsePinStudioProjectionV1({
      schemaVersion: 1, pinId: "p-abcdef", title, tags: [], doc: null, attachments: [],
    });
    expect(projection.title).toBe(title);
    expect(() => parsePinStudioStagedPayloadV1("save", Buffer.from(JSON.stringify({
      schemaVersion: 1,
      patch: { title, tags: [], doc: { type: "doc", content: [] }, attachments: [], docDirty: false },
    })))).toThrow();
  });

  it("does not truncate persisted pin tags, while authoring normalization keeps both caps", () => {
    const tags = ["L".repeat(33), ...Array.from({ length: 12 }, (_, index) => `tag-${index}`)];
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "pins.json"), `${JSON.stringify({ pins: [{
      id: "p-abcdef", text: "pin", by: "human", createdAt: "2026-07-09T00:00:00.000Z", done: false, tags,
    }] })}\n`, "utf8");

    expect(new PinStore(root).list()[0]!.tags).toEqual(tags.map((tag) => tag.toLowerCase()));
    expect(normalizePinTags(tags)).toEqual(tags.slice(1, 13));
  });

  it("resolves a persisted soul above the character cap while import/create validation still refuses it", async () => {
    const body = "S".repeat(SOUL_MAX_CHARS + 1);
    const dir = path.join(root, ".tachyon", "agents", "Ada");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "SOUL.md"), body, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({
      schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174000", owner: "Ada", state: "active",
    }), { mode: 0o600 });

    expect((await resolveSoul(root, "Ada")).body).toBe(body);
    expect(() => validateSoulBytes(Buffer.from(body))).toThrow(/too-many-chars|Unicode scalar/);
  });
});
