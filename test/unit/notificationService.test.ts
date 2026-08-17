import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationService, type NotificationRequest, type UiNotificationPort } from "../../apps/vscode-extension/src/workspace/NotificationService.js";
import { showNotification } from "../../apps/vscode-extension/src/workspace/NotificationService.js";
import { initializeVsCodeNotifications, notify } from "../../apps/vscode-extension/src/workspace/notify.js";
import {
  __getQuickPickCalls,
  __getStatusBarMessages,
  __getWarningMessageCalls,
  __resetVscodeMock,
  __setQuickPickResult,
  __setWarningMessageResult,
} from "../mocks/vscode.js";

class RecordingProvider implements UiNotificationPort {
  readonly requests: NotificationRequest[] = [];

  constructor(private readonly choice?: string) {}

  notify(request: NotificationRequest): Promise<string | undefined> {
    this.requests.push(request);
    return Promise.resolve(this.choice);
  }
}

describe("NotificationService", () => {
  it("defaults to a headless no-op provider", async () => {
    await expect(new NotificationService().show("headless")).resolves.toBeUndefined();
  });

  it("routes simple notifications through the configured provider", () => {
    const provider = new RecordingProvider();
    const service = new NotificationService(provider);

    service.notify("hello", "warn");

    expect(provider.requests).toEqual([{ message: "hello", level: "warn", actions: [] }]);
  });

  it("returns the selected action label", async () => {
    const provider = new RecordingProvider("Open");
    const service = new NotificationService(provider);

    await expect(service.show("done", "info", ["Open"], { modal: true })).resolves.toBe("Open");
    expect(provider.requests[0]).toMatchObject({
      message: "done",
      level: "info",
      modal: true,
      actions: [{ label: "Open" }],
    });
  });

  it("runs selected action callbacks", async () => {
    let ran = false;
    const provider = new RecordingProvider("Run");
    const service = new NotificationService(provider);

    await service.showActions("ready", "info", [{ label: "Run", run: () => { ran = true; } }]);

    expect(ran).toBe(true);
  });
});

describe("VS Code notification routing (spec 415)", () => {
  const projected: Array<{ message: string; level: "info" | "warn" | "error" }> = [];

  beforeEach(() => {
    __resetVscodeMock();
    projected.length = 0;
    initializeVsCodeNotifications((message, level) => {
      projected.push({ message, level });
      return Promise.resolve();
    });
  });

  it("pushes action-less notices into projected state", async () => {
    notify("saved", "info");
    await vi.waitFor(() => expect(projected).toEqual([{ message: "Tachyon: saved", level: "info" }]));
    expect(__getStatusBarMessages()).toHaveLength(0);
    expect(__getWarningMessageCalls()).toHaveLength(0);
  });

  it("degrades visibly when projected-state delivery fails", async () => {
    initializeVsCodeNotifications(() => Promise.reject(new Error("socket unavailable")));
    notify("still visible", "warn");

    await vi.waitFor(() => expect(__getWarningMessageCalls()).toEqual([{
      message: "Tachyon: still visible",
      options: undefined,
      actions: [],
    }]));
    expect(__getStatusBarMessages()).toHaveLength(0);
  });

  it("routes non-modal choices through QuickPick", async () => {
    __setQuickPickResult("Open");
    await expect(showNotification("ready", "warn", ["Open"])).resolves.toBe("Open");
    expect(__getQuickPickCalls()).toEqual([{
      items: ["Open"],
      options: { title: "Tachyon: ready", ignoreFocusOut: true },
    }]);
    expect(projected).toHaveLength(0);
    expect(__getWarningMessageCalls()).toHaveLength(0);
  });

  it("retains native presentation only for explicit modals", async () => {
    __setWarningMessageResult("Delete");
    await expect(showNotification("delete?", "warn", ["Delete"], { modal: true, detail: "Cannot be undone" }))
      .resolves.toBe("Delete");
    expect(__getWarningMessageCalls()).toEqual([{
      message: "Tachyon: delete?",
      options: { modal: true, detail: "Cannot be undone" },
      actions: ["Delete"],
    }]);
    expect(__getQuickPickCalls()).toHaveLength(0);
    expect(projected).toHaveLength(0);
    expect(__getStatusBarMessages()).toHaveLength(0);
  });
});
