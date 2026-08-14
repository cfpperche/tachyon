import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceCommandSuccessV1, workspaceTaskDetailViewSuccessV1 } from "@tachyon/engine/engine-service/protocol.js";
import type { BoardTaskPatchV1 } from "@tachyon/engine/runtime-api/boardCommands.js";
import type { TaskPrototypeReviewActionV1 } from "../../apps/vscode-extension/src/shell/TaskDetailTarget.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { legacyTaskDetailTarget, workspaceTaskDetailTarget } from "../../apps/vscode-extension/src/shell/TaskDetailTarget.js";
import { TaskPrototypeStore } from "@tachyon/engine/tasks/TaskPrototypeStore.js";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace Task Detail target", () => {
  it("loads the remote projection, routes exact mutations with fresh ids, and hydrates only verified local media", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-detail-target-"));
    roots.push(root);
    const prototype = new TaskPrototypeStore(root, "t-abc123").createDraft({
      html: "<main>verified prototype</main>",
      title: "Proposal",
      author: "codex",
      now: "2026-07-14T12:00:01.000Z",
    });
    const revision = prototype.prototypes[0]!;
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async (query) => {
        expect(query).toEqual({ schemaVersion: 1, method: "task.detail", input: { id: "t-abc123" } });
        return workspaceTaskDetailViewSuccessV1({
          schemaVersion: 1,
          detail: {
            schemaVersion: 1,
            task: {
              id: "t-abc123",
              title: "remote task",
              status: "triaged",
              author: "human",
              createdAt: "2026-07-14T12:00:00.000Z",
              updatedAt: "2026-07-14T12:00:00.000Z",
            },
            journal: [],
            deps: [],
            imageAttachments: [],
            prototypes: {
              updatedAt: prototype.updatedAt,
              readOnly: false,
              prototypes: [{
                id: revision.id,
                sha256: revision.sha256,
                state: revision.state,
                title: revision.title,
                author: revision.author,
                createdAt: revision.createdAt,
                available: true,
                integrity: "verified",
              }],
            },
          },
        });
      },
      invoke: async (_operationId, command) => workspaceCommandSuccessV1(command),
    });
    const target = workspaceTaskDetailTarget(fake);

    expect(await target.loadTaskDetail("t-abc123")).toMatchObject({ task: { title: "remote task" } });
    expect(target.prototypeHtml("t-abc123", revision.id)).toBe("<main>verified prototype</main>");
    expect(target.attachmentBlobRoot("t-abc123")).toBe(path.join(root, ".tachyon", "tasks", "attachments", "t-abc123", "blobs"));
    expect(() => target.attachmentBlobPath("t-abc123", "../escape")).toThrow(/invalid task attachment blob ref/);

    await target.updateTask("t-abc123", {
      assignee: "codex",
      expect: { updatedAt: "2026-07-14T12:00:00.000Z" },
    });
    await target.reviewPrototype("t-abc123", {
      prototypeId: revision.id,
      action: "approve",
      expectUpdatedAt: prototype.updatedAt!,
      review: "ship it",
    });
    expect(fake.invocations.map((entry) => entry.command)).toEqual([
      {
        schemaVersion: 1,
        method: "task.update",
        input: { id: "t-abc123", patch: { assignee: "codex", expect: { updatedAt: "2026-07-14T12:00:00.000Z" } } },
      },
      {
        schemaVersion: 1,
        method: "task.prototype.review",
        input: {
          taskId: "t-abc123",
          prototypeId: revision.id,
          action: "approve",
          expectUpdatedAt: prototype.updatedAt,
          review: "ship it",
        },
      },
    ]);
    expect(fake.invocations.map((entry) => entry.operationId)).toEqual([
      expect.stringMatching(/^task-detail:[0-9a-f-]{36}$/),
      expect.stringMatching(/^task-detail:[0-9a-f-]{36}$/),
    ]);
    expect(new Set(fake.invocations.map((entry) => entry.operationId)).size).toBe(2);
  });

  it("keeps legacy and remote adapters on the same closed mutation surface", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-detail-target-legacy-"));
    roots.push(root);
    const store = new TaskStore(root);
    const task = await store.create({ id: "t-abc123", title: "unchanged", author: "human" });
    const target = legacyTaskDetailTarget({
      workspaceRoot: root,
      wsHash: "workspace-hash-1",
      folderName: "fixture",
      taskStore: store,
    });

    await expect(target.updateTask(
      task.id,
      { title: "forged broad edit" } as unknown as BoardTaskPatchV1,
    )).rejects.toThrow(/invalid Task Detail task update/);
    await expect(target.reviewPrototype(task.id, {
      prototypeId: "p-0123456789ab",
      action: "note",
      expectUpdatedAt: "2026-07-14T12:00:00.000Z",
    } as TaskPrototypeReviewActionV1)).rejects.toThrow(/invalid Task Detail prototype review/);
    expect(store.get(task.id).title).toBe("unchanged");
  });

  it("does not turn a typed daemon refusal into apparent success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-detail-target-error-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => ({
        schemaVersion: 1,
        method: command.method,
        status: "error",
        code: "COMMAND_FAILED",
        message: "precondition-failed: stale task",
      }),
    });
    await expect(workspaceTaskDetailTarget(fake).updateTask("t-abc123", { priority: 1 }))
      .rejects.toThrow(/stale task/);
  });
});
