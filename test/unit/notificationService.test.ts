import { describe, expect, it } from "vitest";
import { NotificationService, type NotificationRequest, type UiNotificationPort } from "../../src/workspace/NotificationService.js";

class RecordingProvider implements UiNotificationPort {
  readonly requests: NotificationRequest[] = [];

  constructor(private readonly choice?: string) {}

  notify(request: NotificationRequest): Promise<string | undefined> {
    this.requests.push(request);
    return Promise.resolve(this.choice);
  }
}

describe("NotificationService", () => {
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
