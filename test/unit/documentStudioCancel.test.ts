import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { __getWarningMessageCalls, __resetVscodeMock, __setWarningMessageResult } from "../mocks/vscode.js";
import { confirmDocumentStudioCancel } from "../../src/webview/shared/studio/documentStudioCancel.js";

describe("document studio Cancel", () => {
  beforeEach(() => __resetVscodeMock());

  it("discards immediately when the draft is clean", async () => {
    const discard = vi.fn();
    await confirmDocumentStudioCancel(false, vi.fn(), discard);
    expect(__getWarningMessageCalls()).toEqual([]);
    expect(discard).toHaveBeenCalledOnce();
  });

  it("offers the two affirmatives as buttons and names the third in the detail line", async () => {
    // Three destinations, two controls. VS Code appends its own dismiss button to a modal, so passing
    // "Continue editing" too produced FOUR buttons of which two did the same thing — the redundancy
    // that got the read-mode breadcrumb removed. The dismiss button cannot carry the meaning on its
    // own here (the action being confirmed is itself called "Cancel"), so the detail line says it.
    await confirmDocumentStudioCancel(true, vi.fn(), vi.fn());
    expect(__getWarningMessageCalls()).toEqual([{
      message: "This draft has unsaved changes. What would you like to do?",
      options: { modal: true, detail: "Dismissing this dialog keeps the draft open for editing." },
      actions: ["Save", "Discard"],
    }]);
  });

  it("saves and leaves edit mode only after a successful save", async () => {
    __setWarningMessageResult("Save");
    const discard = vi.fn();
    expect(await confirmDocumentStudioCancel(true, async () => true, discard)).toBe("saved");
    expect(discard).not.toHaveBeenCalled();
  });

  it("preserves the draft and stays in edit mode when save reports a CAS conflict", async () => {
    __setWarningMessageResult("Save");
    const discard = vi.fn();
    expect(await confirmDocumentStudioCancel(true, async () => false, discard)).toBe("editing");
    expect(discard).not.toHaveBeenCalled();
  });

  it("discards only when explicitly selected", async () => {
    __setWarningMessageResult("Discard");
    const discard = vi.fn();
    expect(await confirmDocumentStudioCancel(true, vi.fn(), discard)).toBe("discarded");
    expect(discard).toHaveBeenCalledOnce();
  });

  it("does nothing when the dialog is dismissed — the third destination", async () => {
    // undefined is what VS Code returns for Esc or its own dismiss button, and it must land on
    // "editing": the draft is the thing the whole dialog exists to protect, so the ambiguous answer
    // must never be the destructive one.
    __setWarningMessageResult(undefined);
    const save = vi.fn();
    const discard = vi.fn();
    expect(await confirmDocumentStudioCancel(true, save, discard)).toBe("editing");
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("removes the misleading read-mode breadcrumbs from Task and Pin", () => {
    const task = fs.readFileSync("packages/webview-ui/src/webview/task-detail/main.tsx", "utf8");
    const pin = fs.readFileSync("packages/webview-ui/src/webview/pin-preview/main.tsx", "utf8");
    expect(task).not.toContain("Read task");
    expect(pin).not.toContain("Read pin");
  });
});
