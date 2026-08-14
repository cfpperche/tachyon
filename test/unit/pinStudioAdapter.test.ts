import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { PinStore } from "@tachyon/engine/pins/PinStore.js";
import { legacyPinStudioTarget } from "../../apps/vscode-extension/src/shell/PinStudioTarget.js";
import { PinStudioAdapter } from "../../apps/vscode-extension/src/webview/PinStudioAdapter.js";
import type { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { computePinDirty, serializePinPatch, canDiscardPinFields, type PinFields } from "../../packages/webview-ui/src/webview/pin-studio/domain.js";
import { makeTempDir } from "../helpers/tempDir.js";

/**
 * t-610705 (SDD 410 Phase D, D3) — PinStudioAdapter in isolation: no vscode or panel, with the legacy
 * target proving the same narrow contract the persistent WorkspaceClient target implements. Mirrors
 * taskStudioAdapter.test.ts's (D2) structure; panel-lifecycle behavior (reveal-existing, per-panel
 * webview posting) is genuinely retired along with PinStudioPanelManager — Control is a singleton now
 * — and isn't ported. attachImage/importImage/storeSketch domain-message coverage lives in
 * pinStudioDomain.test.ts instead (this file only exercises adapter.load/save/validate directly).
 */

function mkroot(): string {
  return makeTempDir("pin-studio-adapter-");
}

function fakeWorkspace(root = mkroot()): Workspace {
  return {
    wsHash: "ws-1",
    folderName: "Project",
    workspaceRoot: root,
    pinStore: new PinStore(root),
  } as unknown as Workspace;
}

function baseFields(overrides: Partial<PinFields> = {}): PinFields {
  return {
    title: "x",
    tags: [],
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    attachments: [],
    docDirty: false,
    ...overrides,
  };
}

describe("PinStudioAdapter — load", () => {
  it("returns an empty new-pin entity when entityId is undefined", async () => {
    const ws = fakeWorkspace();
    const adapter = new PinStudioAdapter(legacyPinStudioTarget(ws));
    const result = await adapter.load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.title).toBe("");
    expect(result.entity.pinId).toBeUndefined();
  });

  it("loads an existing pin's title/tags", async () => {
    const ws = fakeWorkspace();
    const pin = await ws.pinStore.create("old", "human", { tags: ["bug"] });
    const adapter = new PinStudioAdapter(legacyPinStudioTarget(ws));
    const result = await adapter.load(pin.id);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.pinId).toBe(pin.id);
    expect(result.entity.title).toBe("old");
    expect(result.entity.tags).toEqual(["bug"]);
  });
});

describe("PinStudioAdapter — save", () => {
  it("saves a new text-only pin without creating a rich detail file", async () => {
    const ws = fakeWorkspace();
    const adapter = new PinStudioAdapter(legacyPinStudioTarget(ws));
    const result = await adapter.save(undefined, baseFields({ title: "just text", tags: ["Docs"] }));
    expect(result.status).toBe("ok");
    const [pin] = ws.pinStore.list();
    expect(pin!.text).toBe("just text");
    expect(pin!.tags).toEqual(["docs"]);
    expect("detail" in pin!).toBe(false);
    expect(fs.existsSync(ws.pinStore.detailPath(pin!.id))).toBe(false);
  });

  it("saves a rich pin (non-empty doc) with a detail sidecar", async () => {
    const ws = fakeWorkspace();
    const adapter = new PinStudioAdapter(legacyPinStudioTarget(ws));
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] };
    const result = await adapter.save(undefined, baseFields({ title: "with body", doc }));
    expect(result.status).toBe("ok");
    const [pin] = ws.pinStore.list();
    expect(pin).toMatchObject({ text: "with body", detail: true });
  });

  it("updates title/tags on an existing pin", async () => {
    const ws = fakeWorkspace();
    const pin = await ws.pinStore.create("old", "human", { tags: ["bug"] });
    const adapter = new PinStudioAdapter(legacyPinStudioTarget(ws));
    const result = await adapter.save(pin.id, baseFields({
      title: "old",
      tags: ["done"],
      expectUpdatedAt: pin.updatedAt ?? pin.createdAt,
    }));
    expect(result.status).toBe("ok");
    expect(ws.pinStore.list()[0]).toMatchObject({ text: "old", tags: ["done"] });
  });
});

describe("PinStudioAdapter — validate/concurrency/dirty hooks", () => {
  it("requires a non-blank title", async () => {
    const ws = fakeWorkspace();
    const adapter = new PinStudioAdapter(legacyPinStudioTarget(ws));
    expect(adapter.validate(baseFields({ title: "" })).blocking).toHaveLength(1);
    expect(adapter.validate(baseFields({ title: "   " })).blocking).toHaveLength(1);
    expect(adapter.validate(baseFields({ title: "ok" })).blocking).toHaveLength(0);
  });

  it("inherits Task Studio's CAS concurrency and allows patch restore", async () => {
    const ws = fakeWorkspace();
    const adapter = new PinStudioAdapter(legacyPinStudioTarget(ws));
    expect(adapter.concurrency).toEqual({ kind: "cas" });
    expect(adapter.allowPatchRestore).toBe(true);
  });

  it("computePinDirty/serializePinPatch/canDiscardPinFields agree on dirty vs clean fields", async () => {
    const clean = baseFields();
    // computePinDirty(undefined, ...) is unconditionally false — "no entity loaded yet" is never
    // itself a dirty state (a brand-new blank draft with nothing typed shouldn't warn on close).
    expect(computePinDirty(undefined, clean)).toBe(false);
    expect(serializePinPatch(clean, false)).toBeUndefined();

    const entity = { workspaceHash: "ws-1", folder: "Project", pinId: "p-1", title: "x", tags: [], doc: clean.doc, attachments: [] };
    expect(computePinDirty(entity, clean)).toBe(false);
    const dirty = baseFields({ title: "changed" });
    expect(computePinDirty(entity, dirty)).toBe(true);
    expect(serializePinPatch(dirty, true)).toBe(dirty);
    expect(canDiscardPinFields(dirty)).toBe(false);

    // t-cdd4e1 — docDirty is an explicit flag, not a structural diff: a doc that's byte-identical to
    // the loaded entity's doc still reads dirty once TipTap's onUpdate has fired at least once, and a
    // structurally-different-but-never-edited doc (the round-trip mismatch this bug was about) must NOT.
    expect(computePinDirty(entity, baseFields({ docDirty: true }))).toBe(true);

    // canDiscardPinFields is its own, stricter question ("is this draft blank enough to close
    // without a confirm?") — unrelated to whether it's dirty relative to some loaded entity.
    const blank = baseFields({ title: "" });
    expect(canDiscardPinFields(blank)).toBe(true);
    expect(canDiscardPinFields(baseFields({ title: "  " }))).toBe(true);
    expect(canDiscardPinFields(clean)).toBe(false); // clean's title "x" is non-blank — not discardable
  });
});
