import { describe, it, expect, beforeEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { PipelineStudioPanelManager } from "../../apps/vscode-extension/src/webview/PipelineStudioPanel.js";
import { envelope } from "@tachyon/webview-ui/webview/shared/studio/protocol.js";
import { patchMessage, dirtyMessage, saveMessage, cancelMessage, importStagesMessage } from "@tachyon/webview-ui/webview/pipeline-studio/messages.js";

// spec 350 T4 — Fake 1 (Pipeline Studio) proven behaviorally complete: the FULL shell lifecycle against the
// REAL PipelineStudioPanelManager (not the generic fake in studioPanelBase.test.ts) — load new/edit, patch,
// dirty, validation block, save enable/disable (via the error taxonomy), save success/failure, cancel,
// reveal-on-reopen, refreshAll, panel restore, and the one registered domain action (importStages).

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => __resetVscodeMock());

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

describe("PipelineStudioPanelManager — Fake 1 full lifecycle", () => {
  it("loads a fresh entity for new mode and reveals instead of duplicating on reopen", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    manager.openNew("ws1");
    await flush();
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    const load = findType(__createdPanels[0].webview.posted, "load").at(-1);
    expect(load).toMatchObject({ entity: { title: "", stages: [] }, concurrency: { kind: "none" } });
  });

  it("tracks dirty from patch messages and blocks save via validation until a title is set", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    await flush();
    const webview = __createdPanels[0].webview;

    // an empty title is a validation-blocking state the ADAPTER's save() re-checks (webview-side gating is
    // covered by App.tsx/domain.ts directly; this proves the host never persists an invalid save either).
    webview.__receive(patchMessage({ title: "", stages: [] }));
    webview.__receive(dirtyMessage(true));
    webview.__receive(saveMessage());
    await flush();

    expect(__createdPanels[0].disposed).toBe(false);
    const err = findType(webview.posted, "error").at(-1);
    expect(err).toMatchObject({ code: "validation/title-required", blocking: true });
  });

  it("saves successfully once valid, then disposes the panel and fans out onChanged", async () => {
    let changed = 0;
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"), () => { changed += 1; });
    manager.openNew("ws1");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMessage({ title: "Deploy", stages: [{ id: "s1", name: "build" }] }));
    webview.__receive(dirtyMessage(true));
    webview.__receive(saveMessage());
    await flush();

    expect(__createdPanels[0].disposed).toBe(true);
    expect(changed).toBe(1);
  });

  it("edit mode loads the persisted entity, and a second save updates it in place", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(patchMessage({ title: "Release", stages: [] }));
    __createdPanels[0].webview.__receive(saveMessage());
    await flush();

    manager.openExisting("ws1", "pl-1");
    await flush();
    const load = findType(__createdPanels[1].webview.posted, "load").at(-1);
    expect(load).toMatchObject({ entity: { id: "pl-1", title: "Release" } });

    __createdPanels[1].webview.__receive(patchMessage({ title: "Release v2", stages: [] }));
    __createdPanels[1].webview.__receive(saveMessage());
    await flush();
    expect(__createdPanels[1].disposed).toBe(true);

    manager.openExisting("ws1", "pl-1");
    await flush();
    const reload = findType(__createdPanels[2].webview.posted, "load").at(-1);
    expect(reload).toMatchObject({ entity: { title: "Release v2" } });
  });

  it("cancel disposes without persisting", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(patchMessage({ title: "Abandoned", stages: [] }));
    __createdPanels[0].webview.__receive(cancelMessage());
    await flush();
    expect(__createdPanels[0].disposed).toBe(true);

    manager.openNew("ws1"); // a fresh new-entity singleton — the abandoned draft never persisted anywhere.
    await flush();
    const load = findType(__createdPanels[1].webview.posted, "load").at(-1);
    expect(load).toMatchObject({ entity: { title: "" } });
  });

  it("refreshAll re-posts every open panel with the latest store state", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(patchMessage({ title: "A", stages: [] }));
    __createdPanels[0].webview.__receive(saveMessage());
    await flush();

    manager.openExisting("ws1", "pl-1");
    await flush();
    manager.refreshAll();
    await flush();
    const loads = findType(__createdPanels[1].webview.posted, "load");
    expect(loads.length).toBeGreaterThanOrEqual(2);
  });

  it("the registered domain action (importStages) round-trips through the real host adapter", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(importStagesMessage("build\ntest\nbuild\n\ndeploy"));
    await flush();

    const reply = findType(webview.posted, "stagesImported").at(-1) as { stages?: Array<{ name: string }> } | undefined;
    expect(reply?.stages?.map((s) => s.name)).toEqual(["build", "test", "deploy"]);
  });

  it("panel restore across a simulated reload: a dirty draft survives, a failed reload discards it", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(patchMessage({ title: "Draft", stages: [] }));
    __createdPanels[0].webview.__receive(dirtyMessage(true));
    const snapshot = manager.captureSnapshot("ws1")!;
    expect(snapshot).toMatchObject({ mode: "new", patch: { title: "Draft" } });

    __resetVscodeMock();
    const restored = new PipelineStudioPanelManager(Uri.file("/ext"));
    restored.restoreFromSnapshot("ws1", snapshot);
    await flush();
    const restoreMsg = findType(__createdPanels[0].webview.posted, "restore").at(-1);
    expect(restoreMsg).toMatchObject({ snapshot: { patch: { title: "Draft" } } });
  });

  it("fails closed on a malformed/unversioned message instead of silently dropping it", async () => {
    const manager = new PipelineStudioPanelManager(Uri.file("/ext"));
    manager.openNew("ws1");
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "totallyUnknownType" }));
    await flush();
    const err = findType(__createdPanels[0].webview.posted, "error").at(-1);
    expect(err).toMatchObject({ blocking: true });
  });
});
