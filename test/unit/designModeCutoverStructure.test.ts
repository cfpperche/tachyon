import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("Design Mode overlay cutover structure", () => {
  it("keeps the host as a bundle loader with no authored overlay markup or CSS", () => {
    const host = read("apps/vscode-extension/src/webview/ide-browser-bridge/designModeInject.ts");
    expect(host).not.toMatch(/(?:innerHTML|outerHTML|insertAdjacentHTML|<style|<aside|<button|cssText)/);
    expect(host).toContain("loadDesignModeOverlayBundle");
    expect(host).toContain("__tachyonDmOverlay.mount");
  });

  it("builds one self-contained IIFE with no imports or chunks", () => {
    const build = read("esbuild.mjs");
    const bundle = read("apps/vscode-extension/dist/webview/design-mode-overlay.js");
    expect(build).toMatch(/const designModeOverlay = [\s\S]*?splitting: false,[\s\S]*?format: "iife",[\s\S]*?sourcemap: false,/);
    expect(bundle).not.toMatch(/\bimport\s*(?:\(|["'{*])/);
    expect(bundle).not.toMatch(/\.\/chunks\//);
  });

  it("has no Design Mode panel, chat app, composer, or reply tool after cutover", () => {
    expect(fs.existsSync(path.join(root, "packages/webview-ui/src/webview/DesignModePanel.ts"))).toBe(false);
    // t-69f737 — the cutover deleted the directory; gone is the stronger claim, and readdirSync threw ENOENT.
    expect(fs.existsSync(path.join(root, "packages/webview-ui/src/webview/design-mode"))).toBe(false);
    expect(read("esbuild.mjs")).not.toMatch(/WEBVIEW_APP_VIEWS\s*=\s*\[[^\]]*"design-mode"/);
    expect(read("apps/vscode-extension/src/webview/webviewApps.ts")).not.toContain('view: "design-mode"');
    expect(read("packages/engine/src/bridge/tools/ide-browser.ts")).not.toContain("design_mode_chat_reply");
    expect(read("apps/vscode-extension/src/webview/ide-browser-bridge/manager.ts")).not.toMatch(/(?:chatWait|sendChatMessage|ingestChatReply|designModeUiSink)/);
  });
});
