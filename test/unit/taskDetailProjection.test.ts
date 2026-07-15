import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseTaskDetailProjectionV1,
  projectTaskDetail,
  type TaskDetailProjectionV1,
} from "../../src/runtime-api/taskDetailProjection.js";
import {
  TASK_DETAIL_RESPONSE_MAX_BYTES,
  workspaceTaskDetailViewSuccessV1,
} from "../../src/engine-service/protocol.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Task Detail wire projection", () => {
  it("projects every field the panel consumes while keeping attachment and prototype bytes out of control", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-detail-projection-"));
    roots.push(root);
    const store = new TaskStore(root);
    const dependency = await store.create({
      id: "t-def456",
      title: "live dependency",
      author: "human",
      now: "2026-07-14T12:00:00.000Z",
    });
    const task = await store.create({
      id: "t-abc123",
      title: "remote detail",
      body: "![shot](attachment:att-abc123)",
      author: "human",
      kind: "implementation",
      priority: 1,
      artifact_refs: [{ type: "sdd", ref: "382-persistent-engine-shell-boundary" }],
      deps: [dependency.id, "t-ffffff"],
      now: "2026-07-14T12:01:00.000Z",
    });
    store.journal.append(task.id, {
      author: "codex",
      text: "projection note",
      now: "2026-07-14T12:02:00.000Z",
    });
    const attachments = new TaskAttachmentStore(root, task.id);
    const image = attachments.putImage({
      data: Buffer.from("private png bytes"),
      mediaType: "image/png",
      name: "shot.png",
      source: "paste",
    });
    new TaskDetailStore(root).write({
      schemaVersion: 1,
      taskId: task.id,
      doc: { type: "doc", content: [] },
      attachments: [{ ...image, id: "att-abc123" }],
      bodyHash: hashBody(task.body!),
      taskUpdatedAt: task.updatedAt,
    });
    const prototype = new TaskPrototypeStore(root, task.id).createDraft({
      html: "<main>private prototype bytes</main>",
      title: "Proposal",
      author: "codex",
      now: "2026-07-14T12:03:00.000Z",
    });

    const projected = projectTaskDetail(store, root, task.id);

    expect(projected).toMatchObject({
      schemaVersion: 1,
      task: {
        id: task.id,
        title: "remote detail",
        body: "![shot](attachment:att-abc123)",
        kind: "implementation",
        priority: 1,
      },
      journal: [{ author: "codex", text: "projection note" }],
      deps: [
        { id: dependency.id, title: "live dependency", status: "inbox", missing: false },
        { id: "t-ffffff", missing: true },
      ],
      imageAttachments: [{ id: "att-abc123", blobRef: image.blobRef, available: true }],
      prototypes: {
        updatedAt: prototype.updatedAt,
        readOnly: false,
        prototypes: [{
          id: prototype.prototypes[0]!.id,
          sha256: prototype.prototypes[0]!.sha256,
          title: "Proposal",
          available: true,
          integrity: "verified",
        }],
      },
    });
    expect(Object.keys(projected.prototypes.prototypes[0]!).sort()).toEqual([
      "author", "available", "createdAt", "id", "integrity", "sha256", "state", "title",
    ]);
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain("private png bytes");
    expect(wire).not.toContain("private prototype bytes");
    expect(wire).not.toContain("relativePath");
    expect(wire).not.toContain("reviews");
  });

  it("fails closed on unknown fields, duplicate identities and contradictory availability", () => {
    const projection = minimalProjection();
    expect(() => parseTaskDetailProjectionV1({ ...projection, extra: true })).toThrow();
    expect(() => parseTaskDetailProjectionV1({
      ...projection,
      deps: [{ id: "t-def456", title: "dep", status: "inbox", missing: false }, { id: "t-def456", missing: true }],
    })).toThrow(/duplicate dependency ids/);
    expect(() => parseTaskDetailProjectionV1({
      ...projection,
      prototypes: {
        readOnly: false,
        prototypes: [{
          id: "p-0123456789ab",
          sha256: "a".repeat(64),
          state: "draft",
          title: "proposal",
          author: "codex",
          createdAt: "2026-07-14T12:00:00.000Z",
          available: true,
          integrity: "missing",
        }],
      },
    })).toThrow(/availability contradicts integrity/);
  });

  it("measures the exact newline-terminated response envelope and rejects a valid oversized view", () => {
    const ordinary = workspaceTaskDetailViewSuccessV1({ schemaVersion: 1, detail: minimalProjection() });
    expect(Buffer.byteLength(`${JSON.stringify({ ok: true, op: "query", result: ordinary })}\n`, "utf8"))
      .toBeLessThan(TASK_DETAIL_RESPONSE_MAX_BYTES);

    const oversized: TaskDetailProjectionV1 = parseTaskDetailProjectionV1({
      ...minimalProjection(),
      journal: Array.from({ length: 600 }, (_, index) => ({
        id: `j-${index.toString(16).padStart(12, "0")}`,
        ts: "2026-07-14T12:00:00.000Z",
        author: "codex",
        text: "x".repeat(4_000),
      })),
    });
    expect(() => workspaceTaskDetailViewSuccessV1({ schemaVersion: 1, detail: oversized }))
      .toThrow(/dedicated response size limit/);
  });
});

function minimalProjection(): TaskDetailProjectionV1 {
  return parseTaskDetailProjectionV1({
    schemaVersion: 1,
    task: {
      id: "t-abc123",
      title: "one",
      status: "inbox",
      author: "human",
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
    },
    journal: [],
    deps: [],
    imageAttachments: [],
    prototypes: { readOnly: false, prototypes: [] },
  });
}
