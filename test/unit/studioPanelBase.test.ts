import { describe, it, expect, beforeEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { StudioPanelManagerBase, type StudioSurfaceConfig } from "../../src/webview/shared/studio/StudioPanelManagerBase.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "../../src/webview/shared/studio/adapter.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import type { StudioRestoreSnapshot } from "../../src/webview/shared/studio/protocol.js";

// spec 350 T2 — StudioPanelManagerBase exercised against a tiny in-memory fake adapter (the same style as
// pinStudioPanel.test.ts's fake webview): lifecycle, dirty/patch tracking, save success/failure through the
// standard error mapping, cancel, reveal-on-reopen, refreshAll, and panel restore across a SIMULATED reload
// (plan.md's accepted Phase 1 proof — a fresh manager instance fed a captured snapshot).
//
// The base's load/save paths are `await`-based (an adapter MAY be async), so even a synchronous fake adapter
// resolves its `load()`/`save()` on a microtask tick — `flush()` drains the event loop before assertions,
// same reason pinStudioPanel.test.ts's async handlers get an `await new Promise(setTimeout)` after `__receive`.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Widget {
  id: string;
  title: string;
}
type WidgetFields = { title: string };

const surface: StudioSurfaceConfig = { viewType: "test.widget", bundleFile: "widget.js", styleFiles: ["widget.css"] };

function makeAdapter(store: Map<string, Widget>, opts: { allowPatchRestore?: boolean; failSaveFor?: string } = {}) {
  const adapter: StudioHostAdapter<Widget, WidgetFields, WidgetFields> = {
    entityType: "widget",
    domainMessageNames: ["pingWidget"],
    concurrency: { kind: "none" },
    allowPatchRestore: opts.allowPatchRestore ?? true,
    dirty: {
      computeDirty: (entity, fields) => (entity?.title ?? "") !== fields.title,
      serializePatch: (fields, dirty) => (dirty ? fields : undefined),
      canDiscard: (fields) => fields.title === "",
    },
    titleFor: (mode, id) => (mode === "new" ? "New Widget" : `Widget — ${id}`),
    load: (id): StudioLoadResult<Widget> => {
      if (id === undefined) return { status: "ok", entity: { id: "new", title: "" } };
      const found = store.get(id);
      return found ? { status: "ok", entity: found } : { status: "not-found" };
    },
    validate: (fields) => ({
      blocking: fields.title.trim() ? [] : [{ code: "validation/title-required", message: "title required", source: "validation" as const, blocking: true }],
      nonBlocking: [],
    }),
    save: (id, patch): StudioSaveResult => {
      if (patch.title === opts.failSaveFor) return { status: "error", error: { code: "persistence/rejected", message: "rejected by store", source: "persistence" } };
      const key = id ?? `w-${store.size + 1}`;
      store.set(key, { id: key, title: patch.title });
      return { status: "ok" };
    },
  };
  return adapter;
}

beforeEach(() => __resetVscodeMock());

describe("StudioPanelManagerBase lifecycle", () => {
  it("opens a new-entity singleton and reveals it instead of duplicating on reopen", async () => {
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(new Map()));
    manager.openNew("ws1");
    manager.openNew("ws1");
    await flush();
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("posts a load message with the fresh entity for new mode", async () => {
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(new Map()));
    manager.openNew("ws1");
    await flush();
    const loadMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "load");
    expect(loadMsg).toMatchObject({ entity: { title: "" }, concurrency: { kind: "none" } });
  });

  it("opens one panel per entity id, separate from the new-entity singleton", async () => {
    const store = new Map<string, Widget>([["w-1", { id: "w-1", title: "existing" }]]);
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    manager.openNew("ws1");
    manager.openExisting("ws1", "w-1");
    await flush();
    expect(__createdPanels).toHaveLength(2);
  });

  it("posts a persistence error for a not-found entity id", async () => {
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(new Map()));
    manager.openExisting("ws1", "missing");
    await flush();
    const errMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "error");
    expect(errMsg).toMatchObject({ blocking: true, code: "persistence/not-found" });
  });
});

describe("patch / dirty tracking + save", () => {
  it("tracks patch and dirty from webview messages, saves, then disposes the panel", async () => {
    const store = new Map<string, Widget>();
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    manager.openNew("ws1");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(envelope({ type: "patch", patch: { title: "hello" } }));
    webview.__receive(envelope({ type: "dirty", dirty: true }));
    webview.__receive(envelope({ type: "save" }));
    await flush();

    expect([...store.values()]).toEqual([{ id: "w-1", title: "hello" }]);
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("calls onChanged after a successful save (the refreshAll fan-out hook)", async () => {
    let changed = 0;
    const store = new Map<string, Widget>();
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store), () => { changed += 1; });
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "patch", patch: { title: "x" } }));
    __createdPanels[0].webview.__receive(envelope({ type: "save" }));
    await flush();
    expect(changed).toBe(1);
  });

  it("maps a save failure through the standard error taxonomy and keeps the panel open", async () => {
    const store = new Map<string, Widget>();
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store, { failSaveFor: "boom" }));
    manager.openNew("ws1");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(envelope({ type: "patch", patch: { title: "boom" } }));
    webview.__receive(envelope({ type: "save" }));
    await flush();

    expect(__createdPanels[0].disposed).toBe(false);
    const errMsg = webview.posted.find((m) => (m as { type?: string }).type === "error");
    expect(errMsg).toMatchObject({ code: "persistence/rejected", blocking: true });
  });

  it("a save with no patch queued is a no-op (gating already prevents this on the webview side)", async () => {
    const store = new Map<string, Widget>();
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "save" }));
    await flush();
    expect(store.size).toBe(0);
    expect(__createdPanels[0].disposed).toBe(false);
  });

  it("cancel disposes the panel without saving", async () => {
    const store = new Map<string, Widget>();
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "patch", patch: { title: "unsaved" } }));
    __createdPanels[0].webview.__receive(envelope({ type: "cancel" }));
    await flush();
    expect(store.size).toBe(0);
    expect(__createdPanels[0].disposed).toBe(true);
  });
});

describe("protocol fail-closed at the manager boundary", () => {
  it("posts a blocking transport error for an unversioned/malformed message instead of silently dropping it", async () => {
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(new Map()));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive({ type: "save" }); // missing studioProtocolVersion
    await flush();
    const errMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "error");
    expect(errMsg).toMatchObject({ blocking: true });
  });

  it("routes a registered domain message to the onDomainMessage hook, not to core handling", async () => {
    const received: unknown[] = [];
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(new Map()), undefined, (wsKey, entityId, msg) => {
      received.push({ wsKey, entityId, msg });
    });
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "pingWidget", nonce: 1 }));
    await flush();
    expect(received).toEqual([{ wsKey: "ws1", entityId: undefined, msg: envelope({ type: "pingWidget", nonce: 1 }) }]);
  });
});

describe("refreshAll", () => {
  it("re-posts a fresh load message to every open panel", async () => {
    const store = new Map<string, Widget>([["w-1", { id: "w-1", title: "v1" }]]);
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    manager.openExisting("ws1", "w-1");
    await flush();
    store.set("w-1", { id: "w-1", title: "v2" });
    manager.refreshAll();
    await flush();
    const loads = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "load");
    expect(loads.at(-1)).toMatchObject({ entity: { title: "v2" } });
  });
});

describe("panel restore across a simulated reload", () => {
  it("captures nothing for a clean (non-dirty) new-entity panel", async () => {
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(new Map()));
    manager.openNew("ws1");
    await flush();
    const snapshot = manager.captureSnapshot("ws1");
    expect(snapshot).toEqual({ schemaVersion: 1, entityType: "widget", mode: "new" });
  });

  it("captures the unsaved patch for a dirty edit panel when the adapter permits patch restore", async () => {
    const store = new Map<string, Widget>([["w-1", { id: "w-1", title: "orig" }]]);
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    manager.openExisting("ws1", "w-1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "patch", patch: { title: "draft" } }));
    __createdPanels[0].webview.__receive(envelope({ type: "dirty", dirty: true }));

    const snapshot = manager.captureSnapshot("ws1", "w-1")!;
    expect(snapshot).toEqual({ schemaVersion: 1, entityType: "widget", mode: "edit", entityId: "w-1", patch: { title: "draft" } });

    // simulated reload: a BRAND NEW manager instance restores from the captured snapshot.
    __resetVscodeMock();
    const restored = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    restored.restoreFromSnapshot("ws1", snapshot);
    await flush();
    const restoreMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "restore");
    expect(restoreMsg).toMatchObject({ snapshot: { mode: "edit", entityId: "w-1", patch: { title: "draft" } } });
  });

  it("does not capture a patch when the adapter forbids patch restore, even while dirty", async () => {
    const store = new Map<string, Widget>([["w-1", { id: "w-1", title: "orig" }]]);
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store, { allowPatchRestore: false }));
    manager.openExisting("ws1", "w-1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "patch", patch: { title: "draft" } }));
    __createdPanels[0].webview.__receive(envelope({ type: "dirty", dirty: true }));

    const snapshot = manager.captureSnapshot("ws1", "w-1")!;
    expect(snapshot.patch).toBeUndefined();
  });

  it("restores LESS (clean re-load, no patch) when the restored entity fails to load — fail-closed", async () => {
    const store = new Map<string, Widget>([["w-1", { id: "w-1", title: "orig" }]]);
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    manager.openExisting("ws1", "w-1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "patch", patch: { title: "draft" } }));
    __createdPanels[0].webview.__receive(envelope({ type: "dirty", dirty: true }));
    const snapshot = manager.captureSnapshot("ws1", "w-1")!;

    store.delete("w-1"); // the entity vanished before the reload — the load will now fail.
    __resetVscodeMock();
    const restored = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store));
    restored.restoreFromSnapshot("ws1", snapshot as StudioRestoreSnapshot<string, WidgetFields>);
    await flush();

    const restoreMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "restore");
    expect(restoreMsg).toMatchObject({ snapshot: null });
  });

  it("restores clean (no patch) for a dirty snapshot once the entity reloads but restore is otherwise clean", async () => {
    const store = new Map<string, Widget>([["w-1", { id: "w-1", title: "orig" }]]);
    const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store, { allowPatchRestore: false }));
    manager.openExisting("ws1", "w-1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "patch", patch: { title: "draft" } }));
    __createdPanels[0].webview.__receive(envelope({ type: "dirty", dirty: true }));
    const snapshot: StudioRestoreSnapshot<string, WidgetFields> = { schemaVersion: 1, entityType: "widget", mode: "edit", entityId: "w-1" };

    __resetVscodeMock();
    const restored = new StudioPanelManagerBase(Uri.file("/ext"), surface, makeAdapter(store, { allowPatchRestore: false }));
    restored.restoreFromSnapshot("ws1", snapshot);
    await flush();
    const restoreMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "restore");
    expect(restoreMsg).toMatchObject({ snapshot: { mode: "edit", entityId: "w-1", patch: undefined } });
  });
});
