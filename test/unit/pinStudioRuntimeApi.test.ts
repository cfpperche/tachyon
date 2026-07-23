import { describe, expect, it } from "vitest";
import {
  isPinStudioApplyInputV1,
  parsePinStudioStagedPayloadV1,
} from "../../src/runtime-api/pinStudioCommands.js";
import { parsePinStudioProjectionV1 } from "../../src/runtime-api/pinStudioProjection.js";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const ref = {
  schemaVersion: 1 as const,
  token: "a".repeat(48),
  sha256: "b".repeat(64),
  byteSize: 100,
};

function savePayload(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    patch: {
      title: "pin",
      tags: ["ui"],
      doc: EMPTY_DOC,
      attachments: [],
      docDirty: false,
      ...overrides,
    },
  }), "utf8");
}

describe("Pin Studio Runtime API", () => {
  it("binds optional pin identity to only the actions that consume it", () => {
    expect(isPinStudioApplyInputV1({ action: "save", payload: ref })).toBe(true);
    expect(isPinStudioApplyInputV1({ action: "save", pinId: "p-abc123", payload: ref })).toBe(true);
    expect(isPinStudioApplyInputV1({ action: "put-sketch", pinId: "p-abc123", payload: ref })).toBe(true);
    expect(isPinStudioApplyInputV1({ action: "put-image", payload: ref })).toBe(true);
    expect(isPinStudioApplyInputV1({ action: "put-image", pinId: "p-abc123", payload: ref })).toBe(false);
    expect(isPinStudioApplyInputV1({ action: "save", pinId: "../escape", payload: ref })).toBe(false);
  });

  it("accepts one exact bounded save payload and rejects action or shape substitution", () => {
    expect(parsePinStudioStagedPayloadV1("save", savePayload())).toMatchObject({
      schemaVersion: 1,
      patch: { title: "pin", tags: ["ui"] },
    });
    expect(() => parsePinStudioStagedPayloadV1("put-image", savePayload())).toThrow();
    expect(() => parsePinStudioStagedPayloadV1("save", savePayload({ extra: true }))).toThrow();
    expect(() => parsePinStudioStagedPayloadV1("save", Buffer.from("not-json"))).toThrow(/not valid JSON/);
  });

  it("validates a closed projection and rejects duplicate metadata", () => {
    const projection = {
      schemaVersion: 1 as const,
      pinId: "p-abc123",
      title: "pin",
      tags: ["docs"],
      doc: EMPTY_DOC,
      attachments: [],
    };
    expect(parsePinStudioProjectionV1(projection)).toEqual(projection);
    expect(() => parsePinStudioProjectionV1({ ...projection, extra: true })).toThrow();
    expect(() => parsePinStudioProjectionV1({ ...projection, tags: ["docs", "docs"] })).toThrow(/duplicate pin tags/);
    expect(() => parsePinStudioProjectionV1({ ...projection, doc: { type: "doc", secret: "leak" } })).toThrow();
  });
});
