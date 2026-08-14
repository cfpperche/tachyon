import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspacePinStudioApplySuccessV1,
  workspacePinStudioViewSuccessV1,
} from "@tachyon/engine/engine-service/protocol.js";
import { parsePinStudioStagedPayloadV1 } from "@tachyon/engine/runtime-api/pinStudioCommands.js";
import { PinAttachmentStore } from "@tachyon/engine/pins/PinAttachmentStore.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { workspacePinStudioTarget } from "../../apps/vscode-extension/src/shell/PinStudioTarget.js";
import { projectedAgent, projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Workspace Pin Studio target", () => {
  it("loads the projection and stages save/image/sketch through disposable payloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-studio-target-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    let fake!: FakeWorkspaceClient;
    fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity, 0, [projectedAgent("codex", { lifetime: "saved" })]),
      query: async (query) => {
        expect(query).toEqual({ schemaVersion: 1, method: "pin.studio", input: { id: "p-abc123" } });
        return workspacePinStudioViewSuccessV1({
          schemaVersion: 1,
          studio: {
            schemaVersion: 1,
            pinId: "p-abc123",
            title: "remote pin",
            tags: ["ui"],
            doc: { type: "doc", content: [{ type: "paragraph" }] },
            attachments: [],
          },
        });
      },
      invoke: async (_operationId, command) => {
        if (command.method !== "pin.studio.apply") throw new Error("unexpected command");
        const staged = fake.stagedPayloads.find((record) => record.ref.token === command.input.payload.token);
        if (!staged) throw new Error("missing staged payload");
        expect(staged.discarded).toBe(false);
        const payload = parsePinStudioStagedPayloadV1(command.input.action, staged.data);
        if (command.input.action === "save") {
          expect(payload).toMatchObject({ patch: { title: "changed remotely", tags: ["docs"] } });
          return workspacePinStudioApplySuccessV1(command, { outcome: "saved", pinId: "p-abc123" });
        }
        if (command.input.action === "put-image") {
          if (!("dataBase64" in payload) || !("mediaType" in payload)) throw new Error("wrong image payload");
          const attachment = new PinAttachmentStore(root).putImage({
            data: Buffer.from(payload.dataBase64, "base64"),
            mediaType: payload.mediaType,
            source: payload.source,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
          });
          return workspacePinStudioApplySuccessV1(command, { outcome: "attachment-stored", attachment, overSoftLimit: false });
        }
        if (!("sceneJson" in payload)) throw new Error("wrong sketch payload");
        const attachment = new PinAttachmentStore(root).putExcalidraw({
          sceneJson: payload.sceneJson,
          previewData: Buffer.from(payload.previewBase64, "base64"),
          source: payload.source,
          ...(payload.name !== undefined ? { name: payload.name } : {}),
        });
        return workspacePinStudioApplySuccessV1(command, { outcome: "attachment-stored", attachment, overSoftLimit: false });
      },
    });
    const target = workspacePinStudioTarget(fake);

    expect(await target.loadPinStudio("p-abc123")).toMatchObject({
      pinId: "p-abc123",
      title: "remote pin",
      tags: ["ui"],
    });
    await expect(target.savePinStudio("p-abc123", {
      title: "changed remotely",
      tags: ["docs"],
      doc: { type: "doc", content: [{ type: "paragraph" }] },
      attachments: [],
      docDirty: false,
    })).resolves.toEqual({ status: "ok" });
    const image = await target.putPinStudioImage({
      data: Buffer.from("remote image"),
      mediaType: "image/png",
      name: "remote.png",
      source: "paste",
    });
    expect(image.attachment).toMatchObject({ kind: "image", name: "remote.png", available: true });
    if (image.attachment.kind !== "image") throw new Error("expected image");
    // t-610705 (Phase D, D3) — no more `context.asWebviewUri` (a Control-hosted studio route is
    // never handed one); attachment bytes are embedded as a `data:` URI instead (mirrors
    // TaskStudioTarget.ts's D2 fix — see PinStudioTarget.ts's hydrateAttachment doc comment).
    expect(image.attachment.uri).toMatch(/^data:image\/png;base64,/);
    const sketch = await target.putPinStudioSketch("p-abc123", {
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    });
    expect(sketch.attachment).toMatchObject({ kind: "excalidraw", sceneAvailable: true, previewAvailable: true });
    if (sketch.attachment.kind !== "excalidraw") throw new Error("expected excalidraw");
    expect(sketch.attachment.previewUri).toMatch(/^data:image\/png;base64,/);

    expect(fake.invocations.map((entry) => entry.command.method)).toEqual([
      "pin.studio.apply",
      "pin.studio.apply",
      "pin.studio.apply",
    ]);
    expect(fake.invocations.every((entry) => /^pin-studio:[0-9a-f-]{36}$/.test(entry.operationId))).toBe(true);
    expect(fake.stagedPayloads).toHaveLength(3);
    expect(fake.stagedPayloads.every((record) => record.discarded)).toBe(true);
  });

  it("discards a staged payload when the daemon refuses the mutation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-studio-target-error-"));
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

    const target = workspacePinStudioTarget(fake);
    await expect(target.putPinStudioImage({
      data: Buffer.from("image"),
      mediaType: "image/png",
      source: "paste",
    })).rejects.toThrow(/forced refusal/);
    expect(fake.stagedPayloads).toMatchObject([{ discarded: true }]);
  });

  it("refuses a save response that changes an existing Pin identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-studio-target-identity-"));
    roots.push(root);
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => {
        if (command.method !== "pin.studio.apply" || command.input.action !== "save") {
          throw new Error("unexpected command");
        }
        return {
          schemaVersion: 1,
          method: "pin.studio.apply",
          status: "ok",
          action: "save",
          outcome: "saved",
          pinId: "p-def456",
        };
      },
    });

    const target = workspacePinStudioTarget(fake);
    await expect(target.savePinStudio("p-abc123", {
      title: "changed remotely",
      tags: [],
      doc: { type: "doc", content: [{ type: "paragraph" }] },
      attachments: [],
      docDirty: false,
    })).rejects.toThrow(/changed the saved Pin identity/);
    expect(fake.stagedPayloads).toMatchObject([{ discarded: true }]);
  });
});
