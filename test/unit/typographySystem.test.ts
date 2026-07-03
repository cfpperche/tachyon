import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Tachyon webview typography system", () => {
  it("declares the bundled Tachyon mono faces and reading role", () => {
    const css = read("src/webview/shared/design-system.css");
    expect(css).toContain('font-family: "Tachyon Mono"');
    expect(css).toContain('url("fonts/tachyon/JetBrainsMono-Regular.woff2")');
    expect(css).toContain('url("fonts/tachyon/JetBrainsMono-Medium.woff2")');
    expect(css).toContain('url("fonts/tachyon/JetBrainsMono-SemiBold.woff2")');
    expect(css).toContain('url("fonts/tachyon/JetBrainsMono-Bold.woff2")');
    expect(css).toContain('--tachyon-font-mono: "Tachyon Mono"');
    expect(css).toContain("--tachyon-font-reading: var(--vscode-font-family");
    expect(css).toContain("font-size: var(--ds-body)");
    expect(css).toContain("--ds-body: var(--vscode-font-size");
  });

  it("maps Tailwind font utilities into the same typography contract", () => {
    const css = read("src/webview/shared/tailwind-theme.css");
    expect(css).toContain("--font-sans: var(--tachyon-font-mono)");
    expect(css).toContain("--font-mono: var(--tachyon-font-mono)");
    expect(css).toContain("--font-reading: var(--tachyon-font-reading)");
  });

  it("keeps long-form surfaces on the canonical reading token", () => {
    expect(read("src/webview/rich-doc/rich-doc.css")).toContain("font-family: var(--tachyon-font-reading)");
    expect(read("src/webview/task-detail/task-detail.css")).toContain("font-family: var(--tachyon-font-reading)");
    expect(read("src/webview/pin-preview/pin-preview.css")).toContain("font-family: var(--tachyon-font-reading)");
    expect(read("src/webview/activity/activity.css")).toContain(".md { font-family: var(--tachyon-font-reading); }");
  });

  it("does not let panel CSS choose VS Code font families directly", () => {
    const cssFiles = [
      "src/webview/activity/activity.css",
      "src/webview/handoff/handoff.css",
      "src/webview/pin-preview/pin-preview.css",
      "src/webview/pin-studio/pin-studio.css",
      "src/webview/rich-doc/rich-doc.css",
      "src/webview/sidebar/sidebar.css",
      "src/webview/task-detail/task-detail.css",
      "src/webview/task-studio/task-studio.css",
    ];
    for (const file of cssFiles) {
      const css = read(file);
      expect(css, file).not.toContain("--vscode-editor-font-family");
      expect(css, file).not.toContain("--vscode-font-family");
    }
  });

  it("packages Tachyon font assets under dist/webview/fonts/tachyon", () => {
    const build = read("esbuild.mjs");
    expect(build).toContain('rmSync("dist/webview/fonts/tachyon"');
    expect(build).toContain('cpSync("src/webview/shared/fonts/tachyon", "dist/webview/fonts/tachyon"');

    for (const file of [
      "JetBrainsMono-Regular.woff2",
      "JetBrainsMono-Medium.woff2",
      "JetBrainsMono-SemiBold.woff2",
      "JetBrainsMono-Bold.woff2",
      "OFL.txt",
      "README.md",
    ]) {
      expect(existsSync(`src/webview/shared/fonts/tachyon/${file}`), file).toBe(true);
    }
  });
});
