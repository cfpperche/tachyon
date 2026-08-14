import { describe, expect, it } from "vitest";
import {
  decodeTaskStudioBase64,
  parseTaskStudioStagedPayloadV1,
} from "@tachyon/engine/runtime-api/taskStudioCommands.js";
import {
  isTiptapDoc,
  parseTaskStudioProjectionV1,
} from "@tachyon/engine/runtime-api/taskStudioProjection.js";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function savePayload(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    patch: {
      title: "task",
      deps: [],
      artifact_refs: [],
      doc: EMPTY_DOC,
      attachments: [],
      dirty: { title: true },
      docDirty: false,
      ...overrides,
    },
  }), "utf8");
}

describe("Task Studio Runtime API", () => {
  it("accepts one exact bounded save payload and rejects action or shape substitution", () => {
    expect(parseTaskStudioStagedPayloadV1("save", savePayload())).toMatchObject({
      schemaVersion: 1,
      patch: { title: "task", dirty: { title: true } },
    });
    expect(() => parseTaskStudioStagedPayloadV1("put-image", savePayload())).toThrow();
    expect(() => parseTaskStudioStagedPayloadV1("save", savePayload({ extra: true }))).toThrow();
    expect(() => parseTaskStudioStagedPayloadV1("save", savePayload({ expectUpdatedAt: "not-a-timestamp" })))
      .toThrow(/invalid expected task timestamp/);
    expect(() => parseTaskStudioStagedPayloadV1("save", Buffer.from("not-json"))).toThrow(/not valid JSON/);
  });

  it("accepts canonical image bytes and rejects ambiguous or oversized encodings", () => {
    const canonical = Buffer.from("image bytes").toString("base64");
    expect(decodeTaskStudioBase64(canonical, "image")).toEqual(Buffer.from("image bytes"));
    expect(() => decodeTaskStudioBase64("a===", "image")).toThrow(/canonical base64/);
    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    expect(() => decodeTaskStudioBase64(tooLarge, "image")).toThrow(/exceeds 10 MB/);
  });

  it("validates a closed projection and rejects contradictory or duplicate metadata", () => {
    const projection = {
      schemaVersion: 1 as const,
      taskId: "t-abc123",
      title: "task",
      deps: [{ id: "t-def456", title: "dependency", missing: false }],
      artifact_refs: [],
      doc: EMPTY_DOC,
      attachments: [],
      anchor: "load" as const,
      prototypes: { readOnly: false, prototypes: [] },
    };
    expect(parseTaskStudioProjectionV1(projection)).toEqual(projection);
    expect(() => parseTaskStudioProjectionV1({ ...projection, extra: true })).toThrow();
    expect(() => parseTaskStudioProjectionV1({
      ...projection,
      deps: [...projection.deps, ...projection.deps],
    })).toThrow(/duplicate Task Studio dependency ids/);
    expect(() => parseTaskStudioProjectionV1({
      ...projection,
      anchor: "read-only",
    })).toThrow(/anchor and error disagree/);
  });

  it("bounds Tiptap documents iteratively and rejects unknown node fields", () => {
    expect(isTiptapDoc(EMPTY_DOC)).toBe(true);
    expect(isTiptapDoc({ type: "doc", secret: "leak" })).toBe(false);
    let nested: Record<string, unknown> = { type: "paragraph" };
    for (let index = 0; index < 65; index += 1) nested = { type: "paragraph", content: [nested] };
    expect(isTiptapDoc({ type: "doc", content: [nested] })).toBe(false);
  });
});
