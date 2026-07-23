import { describe, expect, it, vi } from "vitest";
import { makeStudioAdapterFactory, type CockpitStudios } from "../../src/cockpit/studioRegistry.js";
import type { WorkspaceStudioTarget } from "../../src/shell/WorkspacePresentation.js";

/**
 * t-9dadad — Task/Pin Studio hung on "Loading…" forever in Control: the registry cast the WHOLE
 * workspace handle to the task/pin target types, but WorkspaceShellHandle carries those surfaces as
 * NESTED sub-targets (`handle.taskStudio` / `handle.pinStudio`) — `this.target.loadTaskStudio` was
 * undefined at runtime and the host answered the studio ready-handshake with a
 * "persistence/error: this.target.loadTaskStudio is not a function" envelope. The double
 * `as unknown as` cast hid it from the compiler, and no e2e opened these studios through Control
 * until the 0.56.94 dogfood.
 *
 * These tests drive makeAdapter through a WorkspaceShellHandle-SHAPED fake (nested targets, nothing
 * flat) and assert the adapter's load() actually reaches the nested surface — the exact call that
 * blew up in production.
 */

function handleShapedWorkspace() {
  const loadTaskStudio = vi.fn(async (id: string | undefined) => ({ taskId: id ?? "t-new000", fields: {}, doc: { type: "doc", content: [] }, attachments: [], artifactRefs: [], deps: [], anchor: "editable", expectUpdatedAt: "2026-07-23T00:00:00.000Z" }));
  const loadPinStudio = vi.fn(async (id: string | undefined) => ({ pinId: id ?? "p-new000", fields: { title: "", tags: [] }, doc: { type: "doc", content: [] }, attachments: [], expectRevision: "r1" }));
  const ws = {
    workspaceRoot: "/ws",
    wsHash: "ws-hash-1",
    folderName: "Project",
    taskStudio: { loadTaskStudio },
    pinStudio: { loadPinStudio },
  } as unknown as WorkspaceStudioTarget;
  return { ws, loadTaskStudio, loadPinStudio };
}

const depsFor = (ws: WorkspaceStudioTarget): CockpitStudios => ({ getWorkspaces: () => [ws], onChanged: () => {} });

describe("t-9dadad: studio registry resolves the NESTED task/pin targets off the workspace handle", () => {
  it("task adapter load() reaches handle.taskStudio.loadTaskStudio", async () => {
    const { ws, loadTaskStudio } = handleShapedWorkspace();
    const adapter = makeStudioAdapterFactory(depsFor(ws))({ studio: "task", wsHash: "ws-hash-1" });
    expect(adapter).toBeDefined();
    const result = await adapter!.load("t-abc123");
    expect(loadTaskStudio).toHaveBeenCalledWith("t-abc123");
    expect(result.status).toBe("ok");
  });

  it("pin adapter load() reaches handle.pinStudio.loadPinStudio", async () => {
    const { ws, loadPinStudio } = handleShapedWorkspace();
    const adapter = makeStudioAdapterFactory(depsFor(ws))({ studio: "pin", wsHash: "ws-hash-1" });
    expect(adapter).toBeDefined();
    const result = await adapter!.load("p-abc123");
    expect(loadPinStudio).toHaveBeenCalledWith("p-abc123");
    expect(result.status).toBe("ok");
  });

  it("a handle missing its nested target fails LOUDLY at adapter construction, not as a silent undefined call", () => {
    const bare = { workspaceRoot: "/ws", wsHash: "ws-hash-1", folderName: "Project" } as unknown as WorkspaceStudioTarget;
    expect(() => makeStudioAdapterFactory(depsFor(bare))({ studio: "task", wsHash: "ws-hash-1" }))
      .toThrow(/missing its nested 'taskStudio'/);
    expect(() => makeStudioAdapterFactory(depsFor(bare))({ studio: "pin", wsHash: "ws-hash-1" }))
      .toThrow(/missing its nested 'pinStudio'/);
  });
});
