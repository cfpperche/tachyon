import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderGatePage } from "../../src/webview/ui-gate/gatePage.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("QuickPicker font-free packaging (t-de3dfc)", () => {
  it("owns every ds-qp rule in one font-free sheet", () => {
    const design = read("src/webview/shared/design-system.css");
    const picker = read("src/webview/shared/quick-picker.css");
    expect(design).not.toContain(".ds-qp");
    expect(picker).toContain(".ds-qp-panel");
    expect(picker).not.toContain("@font-face");
  });

  it("links the picker layer in the shared baseline and the xterm-safe Agent Pane", () => {
    const gate = renderGatePage("https://example.test");
    const pluginHost = read("src/plugins/ui/host.ts");
    const pane = read("src/webview/AgentPanePanel.ts");
    expect(gate).toContain('href="https://example.test/dist/webview/quick-picker.css"');
    expect(pluginHost).toContain("...SHELL_BASE_STYLESHEETS.map(uri)");
    expect(pane).toContain('styles: [uri("xterm.css"), uri("quick-picker.css"), uri("agent-pane.css")]');
    expect(pane).not.toContain('uri("design-system.css")');
  });

  it("copies the new sheet into the shipped webview assets", () => {
    expect(read("esbuild.mjs")).toContain('copyFileSync("src/webview/shared/quick-picker.css", "dist/webview/quick-picker.css")');
  });
});
