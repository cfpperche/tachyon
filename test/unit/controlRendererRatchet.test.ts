import { describe, expect, it } from "vitest";
import fs from "node:fs";

/**
 * SDD 485 E1 — the renderer ratchet reached zero and Control was deleted. The useful successor is a
 * resurrection guard: the retired host/client/view/entry must stay absent while the sidebar launcher
 * and every `tachyon.*` compatibility command remain.
 */
const absent = [
  "packages/webview-ui/src/webview/Cockpit.ts",
  "packages/webview-ui/src/webview/cockpit/App.tsx",
  "packages/webview-ui/src/webview/cockpit/main.tsx",
  "packages/webview-ui/src/webview/cockpit/SectionShell.tsx",
  "packages/webview-ui/src/webview/cockpit/cockpit.css",
  "packages/webview-ui/src/webview/cockpitSingleton.ts",
  "packages/webview-ui/src/webview/ApprovalPanel.ts",
];

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("SDD 485 E1 — Control cannot return through another door", () => {
  it("keeps the retired Control implementation absent", () => {
    expect(absent.filter((file) => fs.existsSync(file))).toEqual([]);
  });

  it("keeps Control out of the app build and surface manifest", () => {
    expect(read("esbuild.mjs")).not.toMatch(/WEBVIEW_APP_VIEWS\s*=\s*\[[^\]]*["']cockpit["']/s);
    expect(read("esbuild.mjs")).not.toContain("packages/webview-ui/src/webview/cockpit/cockpit.css");
    expect(read("esbuild.mjs")).toContain('["cockpit.js", "cockpit.js.map", "cockpit.css"]');
    expect(read("src/webview/surfaces.ts")).not.toContain('viewId: "tachyonCockpit"');
  });

  it("keeps the sidebar launcher and command compatibility doors", () => {
    const extension = read("apps/vscode-extension/src/extension.ts");
    expect(extension).toContain("SidebarPrototypeProvider.viewType");
    expect(extension).toContain('registerCommand("tachyon.openControl"');
    expect(extension).toContain('registerCommand("tachyon.openCockpit"');
    expect(extension).toContain('registerTrustedPanelSerializer<{ schemaVersion: 1 | 2; view: string; wsHash?: unknown }>(context, "tachyonCockpit"');
  });
});
