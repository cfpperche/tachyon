import { describe, expect, it } from "vitest";
import fs from "node:fs";

/**
 * SDD 485 E1 — the renderer ratchet reached zero and Control was deleted. The useful successor is a
 * resurrection guard: the retired host/client/view/entry must stay absent while the sidebar launcher
 * and the live `tachyon.*` commands remain without resurrecting retired aliases.
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
    expect(read("apps/vscode-extension/src/webview/surfaces.ts")).not.toContain('viewId: "tachyonCockpit"');
  });

  it("keeps the sidebar launcher and live command doors", () => {
    const extension = read("apps/vscode-extension/src/extension.ts");
    const manifest = read("apps/vscode-extension/package.json");
    const nls = read("apps/vscode-extension/package.nls.json");
    expect(extension).toContain("SidebarPrototypeProvider.viewType");
    expect(extension).toContain('registerCommand("tachyon.openControl"');
    expect(extension).not.toContain('registerCommand("tachyon.openCockpit"');
    expect(manifest).not.toContain("tachyon.openCockpit");
    expect(nls).not.toContain("command.openCockpit");
    expect(extension).toContain('registerTrustedPanelSerializer<{ schemaVersion: 1 | 2; view: string; wsHash?: unknown }>(context, "tachyonCockpit"');
  });
});
