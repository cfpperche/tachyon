import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { designModeEventWithScreenshot } from "../../src/webview/design-mode/screenshot.js";

describe("designModeEventWithScreenshot", () => {
  const root = path.join("/workspace", ".tachyon", "ide-browser-picks");

  it("serves a pick from the granted root and removes its disk path", () => {
    const file = path.join(root, "pick-123-abcdef.png");
    const asWebviewUri = vi.fn((value: string) => `webview:${value}`);

    const event = designModeEventWithScreenshot(
      { type: "selection", screenshotPath: file },
      root,
      asWebviewUri,
    );

    expect(event).toEqual({ type: "selection", screenshotUri: `webview:${file}` });
    expect(asWebviewUri).toHaveBeenCalledWith(file);
  });

  it("does not resolve or expose a path outside the pick root", () => {
    const asWebviewUri = vi.fn((value: string) => `webview:${value}`);

    const event = designModeEventWithScreenshot(
      { type: "selection", screenshotPath: "/tmp/untrusted.png" },
      root,
      asWebviewUri,
    );

    expect(event).toEqual({ type: "selection" });
    expect(asWebviewUri).not.toHaveBeenCalled();
  });
});
