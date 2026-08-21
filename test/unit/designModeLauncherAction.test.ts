import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settingsModelMessage } from "@tachyon/webview-ui/webview/settings/messages";

const root = path.resolve(__dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("Design Mode launcher action (t-53f20d owner dogfood)", () => {
  it("routes gate-off to highlighted Settings and gate-on to the existing arm/open command", () => {
    const extension = read("apps/vscode-extension/src/extension.ts");
    const arm = extension.indexOf('if (resolved === "design-mode")');
    expect(arm).toBeGreaterThan(-1);
    const branch = extension.slice(arm, extension.indexOf("if (resolved ===", arm + 1));
    expect(branch).toContain("settingsPanels.openIdeBrowser(ws.wsHash)");
    expect(branch).toContain('executeCommand("tachyon.ideBrowserBridge.designModeOn")');
    expect(branch).not.toContain("DesignModePanel");
  });

  it("carries a stable focus nonce through the Settings envelope", () => {
    expect(settingsModelMessage({} as never, 7)).toEqual({
      type: "settingsModel",
      model: {},
      ideBrowserFocusNonce: 7,
    });
    const client = read("packages/webview-ui/src/webview/settings/main.tsx");
    expect(client).toContain("scrollIntoView");
    expect(client).toContain("toggle?.focus");
    expect(client).toContain("ck-settings-highlight");
  });

  it("closing the browser clears armed state at the CDP authority", async () => {
    const { IdeBrowserCdpSession } = await import(
      "../../apps/vscode-extension/src/webview/ide-browser-bridge/cdpSession.js"
    );
    const session = new IdeBrowserCdpSession() as unknown as {
      designModeOn: boolean;
      dispose(): void;
      readonly isDesignModeOn: boolean;
    };
    session.designModeOn = true;
    session.dispose();
    expect(session.isDesignModeOn).toBe(false);
  });

  it("removes both status items while preserving palette commands", () => {
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
});
