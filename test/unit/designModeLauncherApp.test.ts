import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetVscodeMock } from "../mocks/vscode.js";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { DesignModeAction, DesignModeModel, DesignModeStrings } from "@tachyon/webview-ui/webview/design-mode/messages";
import { systemModelMessage } from "@tachyon/webview-ui/webview/system/messages";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

describe("Design Mode launcher cutover (t-53f20d)", () => {
  const strings: DesignModeStrings = {
    title: "Design Mode", hint: "Controls", off: "OFF", disabledTitle: "Integrated Browser is disabled",
    disabledBody: "Enable it in Settings.", openSettings: "Open Settings", armed: "Armed", disarmed: "Disarmed",
    on: "ON", armedBody: "Overlay active.", disarmedBody: "Arm the overlay.", revealBrowser: "Reveal browser",
    openBrowser: "Open browser", disarm: "Disarm", arm: "Arm Design Mode",
  };
  let App: (props: { model?: DesignModeModel; strings: DesignModeStrings; post: (action: DesignModeAction) => void }) => unknown;
  const posted: DesignModeAction[] = [];
  const render = (model: DesignModeModel) => renderStatic(App({ model, strings, post: (action) => posted.push(action) }));

  beforeEach(async () => {
    __resetVscodeMock();
    posted.length = 0;
    App = (await loadWebviewModule(path.join(repoRoot, "packages/webview-ui/src/webview/design-mode/App.tsx"))).App as typeof App;
  });

  it("renders the three approved states, including ON independently of browser-tab focus", () => {
    expect(render({ enabled: false, running: false, cdp: "disconnected", url: "", designModeOn: false }))
      .toContain('data-state="gate-off"');
    expect(render({ enabled: true, running: true, cdp: "connected", url: "https://example.test", designModeOn: false }))
      .toContain('data-state="disarmed"');
    const armed = render({ enabled: true, running: true, cdp: "connected", url: "https://example.test", designModeOn: true });
    expect(armed).toContain('data-state="armed"');
    expect(armed).toContain("ON");
    expect(armed).toContain("Disarm");
  });

  it("removes both StatusBarItem doors while preserving all palette commands", () => {
    const host = read("apps/vscode-extension/src/webview/ide-browser-bridge/register.ts");
    expect(host).not.toContain("createStatusBarItem");
    expect(host).not.toContain("StatusBarItem");
    for (const command of [
      "tachyon.ideBrowserBridge.open",
      "tachyon.ideBrowserBridge.designMode",
      "tachyon.ideBrowserBridge.designModeOn",
      "tachyon.ideBrowserBridge.designModeOff",
    ]) expect(host).toContain(command);
  });

  it("projects URL and CDP into the System envelope", () => {
    const message = systemModelMessage({} as never, { url: "https://example.test", cdp: "connected" });
    expect(message.ideBrowser).toEqual({ url: "https://example.test", cdp: "connected" });
  });
});
