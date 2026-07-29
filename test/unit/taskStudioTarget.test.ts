import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceCommandSuccessV1,
  workspaceTaskStudioApplySuccessV1,
  workspaceTaskStudioViewSuccessV1,
} from "../../src/engine-service/protocol.js";
import { parseTaskStudioStagedPayloadV1 } from "../../src/runtime-api/taskStudioCommands.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { workspaceTaskStudioTarget } from "../../src/shell/TaskStudioTarget.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskStudioAdapter } from "../../src/webview/TaskStudioAdapter.js";
import { projectedAgent, projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace Task Studio target", () => {
  it("loads the remote projection and stages every large mutation through one disposable payload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-studio-target-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    let fake!: FakeWorkspaceClient;
    fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity, 0, [projectedAgent("codex", { lifetime: "saved" })]),
      query: async (query) => {
        expect(query).toEqual({ schemaVersion: 1, method: "task.studio", input: { id: "t-abc123" } });
        return workspaceTaskStudioViewSuccessV1({
          schemaVersion: 1,
          studio: {
            schemaVersion: 1,
            taskId: "t-abc123",
            title: "remote task",
            deps: [],
            artifact_refs: [],
            doc: { type: "doc", content: [{ type: "paragraph" }] },
            attachments: [],
            bodyBaseline: "",
            anchor: "load",
            expectUpdatedAt: "2026-07-14T12:00:00.000Z",
            prototypes: { readOnly: false, prototypes: [] },
          },
        });
      },
      invoke: async (_operationId, command) => {
        if (command.method === "task.studio.cancel") return workspaceCommandSuccessV1(command);
        if (command.method !== "task.studio.apply") throw new Error("unexpected command");
        const staged = fake.stagedPayloads.find((record) => record.ref.token === command.input.payload.token);
        if (!staged) throw new Error("missing staged payload");
        expect(staged.discarded).toBe(false);
        const payload = parseTaskStudioStagedPayloadV1(command.input.action, staged.data);
        if (command.input.action === "save") {
          expect(payload).toMatchObject({ patch: { title: "changed remotely", dirty: { title: true } } });
          return workspaceTaskStudioApplySuccessV1(command, { outcome: "saved" });
        }
        if (command.input.action === "put-image") {
          if (!("dataBase64" in payload) || !("mediaType" in payload)) throw new Error("wrong image payload");
          const attachment = new TaskAttachmentStore(root, command.input.taskId).putImage({
            data: Buffer.from(payload.dataBase64, "base64"),
            mediaType: payload.mediaType,
            source: payload.source,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
          });
          return workspaceTaskStudioApplySuccessV1(command, {
            outcome: "attachment-stored",
            attachment,
            overSoftLimit: false,
          });
        }
        if (command.input.action === "put-sketch") {
          if (!("sceneJson" in payload)) throw new Error("wrong sketch payload");
          const attachment = new TaskAttachmentStore(root, command.input.taskId).putExcalidraw({
            sceneJson: payload.sceneJson,
            previewData: Buffer.from(payload.previewBase64, "base64"),
            source: payload.source,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
          });
          return workspaceTaskStudioApplySuccessV1(command, {
            outcome: "attachment-stored",
            attachment,
            overSoftLimit: false,
          });
        }
        expect(payload).toMatchObject({ html: "<main>proposal</main>", title: "proposal.html" });
        return workspaceTaskStudioApplySuccessV1(command, { outcome: "prototype-imported" });
      },
    });
    const target = workspaceTaskStudioTarget(fake);

    expect(await target.loadTaskStudio("t-abc123")).toMatchObject({
      taskId: "t-abc123",
      title: "remote task",
      knownAgents: ["codex"],
    });
    await expect(target.saveTaskStudio("t-abc123", {
      title: "changed remotely",
      deps: [],
      artifact_refs: [],
      doc: { type: "doc", content: [{ type: "paragraph" }] },
      attachments: [],
      dirty: { title: true },
      docDirty: false,
      expectUpdatedAt: "2026-07-14T12:00:00.000Z",
    })).resolves.toEqual({ status: "ok" });
    const image = await target.putTaskStudioImage("t-abc123", {
      data: Buffer.from("remote image"),
      mediaType: "image/png",
      name: "remote.png",
      source: "paste",
    });
    expect(image.attachment).toMatchObject({ kind: "image", name: "remote.png", available: true });
    if (image.attachment.kind !== "image") throw new Error("expected image");
    expect(image.attachment.uri).toBe(`data:image/png;base64,${Buffer.from("remote image").toString("base64")}`);
    const sketch = await target.putTaskStudioSketch("t-abc123", {
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    });
    expect(sketch.attachment).toMatchObject({ kind: "excalidraw", sceneAvailable: true, previewAvailable: true });
    await target.importTaskStudioPrototype("t-abc123", { html: "<main>proposal</main>", title: "proposal.html" });
    await target.cancelTaskStudio("t-abc123");

    expect(fake.invocations.map((entry) => entry.command.method)).toEqual([
      "task.studio.apply",
      "task.studio.apply",
      "task.studio.apply",
      "task.studio.apply",
      "task.studio.cancel",
    ]);
    expect(fake.invocations.map((entry) => entry.operationId)).toEqual([
      expect.stringMatching(/^task-studio:[0-9a-f-]{36}$/),
      expect.stringMatching(/^task-studio:[0-9a-f-]{36}$/),
      expect.stringMatching(/^task-studio:[0-9a-f-]{36}$/),
      expect.stringMatching(/^task-studio:[0-9a-f-]{36}$/),
      expect.stringMatching(/^task-studio:[0-9a-f-]{36}$/),
    ]);
    expect(fake.stagedPayloads).toHaveLength(4);
    expect(fake.stagedPayloads.every((record) => record.discarded)).toBe(true);
  });

  it("discards a staged payload when the daemon refuses the mutation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-studio-target-error-"));
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
        message: "forced refusal",
      }),
    });

    const target = workspaceTaskStudioTarget(fake);
    await expect(target.putTaskStudioImage("t-abc123", {
      data: Buffer.from("image"),
      mediaType: "image/png",
      source: "paste",
    })).rejects.toThrow(/forced refusal/);
    expect(fake.stagedPayloads).toMatchObject([{ discarded: true }]);
    await expect(new TaskStudioAdapter(target).onCancel("t-abc123")).resolves.toBeUndefined();
  });
});
