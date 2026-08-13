import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { IdeBrowserBridgeManager } from "../../src/webview/ide-browser-bridge/manager.js";

// The browser suite owns this Chromium child and closes it below. Enter through the shipped
// page-overlay binding door, then read the real page viewport back over CDP.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ManagerHarness = any;

describe("Design Mode responsive presets in live Chromium (t-0807b2)", () => {
  let browser: { wsEndpoint(): string; close(): Promise<void> };
  let manager: ManagerHarness;

  beforeAll(async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath: process.env.TACHYON_CHROME || "/usr/bin/google-chrome",
      headless: true,
      defaultViewport: null,
      args: ["--no-sandbox"],
    });
    (vscode as unknown as { debug: unknown }).debug = {
      onDidTerminateDebugSession: () => ({ dispose() {} }),
      onDidStartDebugSession: () => ({ dispose() {} }),
      activeDebugSession: undefined,
      startDebugging: async () => false,
      stopDebugging: async () => {},
    };
    manager = new IdeBrowserBridgeManager(process.cwd(), { appendLine() {} } as unknown as vscode.OutputChannel);
    await manager.session.cdp.connectToDebugSession({
      id: "responsive-live",
      name: "responsive-live",
      customRequest: async (command: string) => {
        if (command !== "requestCDPProxy") throw new Error(`unexpected request: ${command}`);
        return { webSocketDebuggerUrl: browser.wsEndpoint() };
      },
    } as unknown as vscode.DebugSession, () => undefined);
  });

  afterAll(async () => {
    manager?.session.cdp.dispose();
    await browser?.close();
  });

  it("changes the live browser page through every sized webview preset", async () => {
    const readScreen = () => manager.session.cdp.evaluateInPage(
      "({ width: screen.width, height: screen.height })",
    );
    const readLayout = () => manager.session.cdp.evaluateInPage(
      "({ width: innerWidth, height: innerHeight })",
    );
    for (const [preset, width, height] of [
      ["phone", 375, 812],
      ["tablet", 768, 1024],
      ["desktop", 1280, 800],
    ] as const) {
      await manager.handleDesignPickRaw(JSON.stringify({ action: "viewport.set", preset }));
      expect(await (preset === "desktop" ? readLayout() : readScreen())).toEqual({ width, height });
    }
  });
});
