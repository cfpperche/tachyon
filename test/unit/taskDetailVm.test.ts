import { describe, it, expect } from "vitest";
import { buildTaskDetailVm, emptyTombstoneVm } from "../../src/webview/task-detail/taskDetailVm.js";
import { legacyTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import type { TaskDetailProjectionV1 } from "../../src/runtime-api/taskDetailProjection.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

// t-610705 (SDD 410 Phase C.1) — buildTaskDetailVm/emptyTombstoneVm ported verbatim from the retired
// TaskDetailPanelManager's private vmFor/resolveAttachmentRefs/prototypeVm. This file carries over
// the panel-era coverage of the pure VM-building behavior (attachment ref resolution specifically —
// dogfood round 1 #5, spec 339 — the same class of bug the Studio import path already guarded).

function fakeWs(overrides: Partial<Workspace> = {}): Workspace {
  return { wsHash: "ws-1", folderName: "Project", workspaceRoot: "/tmp/x", ...overrides } as unknown as Workspace;
}

function baseProjection(overrides: Partial<TaskDetailProjectionV1["task"]> = {}): TaskDetailProjectionV1 {
  return {
    schemaVersion: 1,
    task: {
      id: "t-abc123",
      title: "a task",
      status: "inbox",
      author: "human",
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
      ...overrides,
    },
    journal: [],
    deps: [],
    imageAttachments: [],
    prototypes: { readOnly: false, prototypes: [] },
  };
}

const noResolve = (localPath: string) => `webview://${localPath}`;

describe("buildTaskDetailVm", () => {
  it("carries task fields, journal, and deps through unchanged", () => {
    const ws = legacyTaskDetailTarget(fakeWs());
    const detail: TaskDetailProjectionV1 = {
      ...baseProjection({ title: "with notes" }),
      journal: [{ id: "j-1", ts: "2026-07-14T12:00:00.000Z", author: "codex", text: "note" }],
      deps: [{ id: "t-dep1", title: "dependency", status: "inbox", missing: false }],
    };
    const vm = buildTaskDetailVm(ws, "t-abc123", detail, false, noResolve);
    expect(vm.tombstone).toBe(false);
    expect(vm.task?.title).toBe("with notes");
    expect(vm.journal).toEqual(detail.journal);
    expect(vm.deps).toEqual(detail.deps);
  });

  it("resolves an attachment: ref in the body to the injected webview URI (dogfood round 1 #5)", () => {
    const ws = legacyTaskDetailTarget(fakeWs());
    const detail: TaskDetailProjectionV1 = {
      ...baseProjection({ body: "see ![shot](attachment:att-1)" }),
      imageAttachments: [{ id: "att-1", blobRef: "b".repeat(64), available: true }],
    };
    const vm = buildTaskDetailVm(ws, "t-abc123", detail, false, (p) => `webview-uri:${p}`);
    expect(vm.task?.body).not.toContain("attachment:att-1");
    expect(vm.task?.body).toContain("webview-uri:");
  });

  it("leaves an unresolvable attachment ref as-is (no matching sidecar entry)", () => {
    const ws = legacyTaskDetailTarget(fakeWs());
    const detail = baseProjection({ body: "![x](attachment:missing)" });
    const vm = buildTaskDetailVm(ws, "t-abc123", detail, false, noResolve);
    expect(vm.task?.body).toBe("![x](attachment:missing)");
  });

  it("leaves an unavailable attachment ref as-is even when the id matches", () => {
    const ws = legacyTaskDetailTarget(fakeWs());
    const detail: TaskDetailProjectionV1 = {
      ...baseProjection({ body: "![x](attachment:att-1)" }),
      imageAttachments: [{ id: "att-1", blobRef: "b".repeat(64), available: false }],
    };
    const vm = buildTaskDetailVm(ws, "t-abc123", detail, false, noResolve);
    expect(vm.task?.body).toBe("![x](attachment:att-1)");
  });

  it("swallows a resolveBlobUri throw for one ref without crashing the whole body", () => {
    const ws = legacyTaskDetailTarget(fakeWs());
    const detail: TaskDetailProjectionV1 = {
      ...baseProjection({ body: "![x](attachment:att-1)" }),
      imageAttachments: [{ id: "att-1", blobRef: "b".repeat(64), available: true }],
    };
    const vm = buildTaskDetailVm(ws, "t-abc123", detail, false, () => { throw new Error("bad ref"); });
    expect(vm.task?.body).toBe("![x](attachment:att-1)"); // left as-is, same outcome as an unresolved ref
  });

  it("sets tombstone true when told to, keeping the last-known task data", () => {
    const ws = legacyTaskDetailTarget(fakeWs());
    const detail = baseProjection({ title: "vanishing" });
    const vm = buildTaskDetailVm(ws, "t-abc123", detail, true, noResolve);
    expect(vm.tombstone).toBe(true);
    expect(vm.task?.title).toBe("vanishing");
  });
});

describe("emptyTombstoneVm", () => {
  it("is a bare not-found shape with no task at all", () => {
    const vm = emptyTombstoneVm("ws-1", "t-gone");
    expect(vm).toEqual({ wsHash: "ws-1", id: "t-gone", tombstone: true, journal: [], deps: [], prototypes: { readOnly: false, prototypes: [] } });
  });
});
