import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { TaskDocumentEditPolicy } from "../../apps/vscode-extension/src/webview/task-detail/editPolicy.js";

describe("SDD 485 D12 — unsaved edits belong to the task document", () => {
  const dirty = () => {
    const policy = new TaskDocumentEditPolicy<{ title: string; expectUpdatedAt: string }>("edit");
    policy.receivePatch({ title: "local", expectUpdatedAt: "revision-1" });
    policy.receiveDirty(true);
    return policy;
  };

  it("keeps the draft when switching from edit to read", () => {
    const policy = dirty();
    policy.switchMode("read");
    expect(policy.mode).toBe("read");
    expect(policy.draft).toEqual({ dirty: true, patch: { title: "local", expectUpdatedAt: "revision-1" } });
  });

  it("returns the pending draft for the manager to retain when the document closes", () => {
    expect(dirty().close()).toEqual({ dirty: true, patch: { title: "local", expectUpdatedAt: "revision-1" } });
  });

  it("lets a new host snapshot update read mode without rebasing or erasing the pending CAS draft", () => {
    const policy = dirty();
    policy.receiveHostSnapshot();
    expect(policy.draft.patch).toEqual({ title: "local", expectUpdatedAt: "revision-1" });
  });

  it("keeps every line in the document panel at or below 200 characters", () => {
    const source = fs.readFileSync("apps/vscode-extension/src/webview/TaskDetailPanel.ts", "utf8");
    expect(source.split("\n").filter((line) => line.length > 200)).toEqual([]);
  });
});
