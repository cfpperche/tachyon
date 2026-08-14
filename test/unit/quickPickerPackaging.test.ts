import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderGatePage } from "../../src/webview/ui-gate/gatePage.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("SDD 505 Slice 1 — tokens, faces, and components are separate", () => {
  it("keeps each shared sheet limited to its declared nature", () => {
    const design = read("packages/webview-ui/src/webview/shared/design-system.css");
    const picker = read("packages/webview-ui/src/webview/shared/quick-picker.css");
    const tokens = read("packages/webview-ui/src/webview/shared/tokens.css");
    const faces = read("packages/webview-ui/src/webview/shared/faces.css");
    expect(design).not.toContain(".ds-qp");
    expect(design).not.toContain("@font-face");
    expect(picker).toContain(".ds-qp-panel");
    expect(picker).not.toContain("@font-face");
    expect(picker).not.toMatch(/(?:^|[;{])\s*--ds-[a-z0-9-]+\s*:/m);
    expect(tokens).toContain("--ds-fg:");
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("@font-face");
    const tokenRules = tokens.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(tokenRules.match(/{/g)).toHaveLength(1);
    expect(tokenRules.trimStart()).toMatch(/^:root\s*\{/);
    expect(faces).toContain("@font-face");
    expect(faces).not.toContain(":root");
  });

  it("links the full baseline normally while Agent Pane skips only faces", () => {
    const gate = renderGatePage("https://example.test");
    const pluginHost = read("src/plugins/ui/host.ts");
    const pane = read("src/webview/AgentPanePanel.ts");
    for (const sheet of ["tokens.css", "faces.css", "design-system.css", "quick-picker.css"]) {
      expect(gate).toContain(`href="https://example.test/dist/webview/${sheet}"`);
    }
    expect(pluginHost).toContain("...SHELL_BASE_STYLESHEETS.map(uri)");
    expect(pane).toContain('uri("tokens.css")');
    expect(pane).toContain('uri("design-system.css")');
    expect(pane).toContain('uri("quick-picker.css")');
    expect(pane).not.toContain('uri("faces.css")');
  });

  it("copies the split sheets into the shipped webview assets", () => {
    expect(read("esbuild.mjs")).toContain('copyFileSync("packages/webview-ui/src/webview/shared/tokens.css", "dist/webview/tokens.css")');
    expect(read("esbuild.mjs")).toContain('copyFileSync("packages/webview-ui/src/webview/shared/faces.css", "dist/webview/faces.css")');
    expect(read("esbuild.mjs")).toContain('copyFileSync("packages/webview-ui/src/webview/shared/quick-picker.css", "dist/webview/quick-picker.css")');
  });
});
