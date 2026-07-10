import { describe, expect, it } from "vitest";

describe("container-generated delegation behavior", () => {
  it("the packaged extension ships only allowlisted files: no dev harness, no fixtures, no source maps", async () => {
    const { classifyShipFile } = await import("../../scripts/ship-boundary.mjs");
    const inventory = {
      "dist/webview-preview/preview.js": "dev-artifact",
      "dist/webview-preview/preview.js.map": "dev-artifact",
      "dist/webview/agent-studio-fixture.js": "dev-artifact",
      "dist/webview/agent-studio-fixture.css": "dev-artifact",
      "dist/extension.js.map": "dev-artifact",
      "dist/webview/sidebar.js.map": "dev-artifact",
      "dist/extension.js": "allowed",
      "dist/webview/sidebar.js": "allowed",
      "dist/webview/pin-preview.js": "allowed",
      "media/icon.png": "allowed",
      "l10n/bundle.l10n.json": "allowed",
      "package.json": "allowed",
      "package.nls.json": "allowed",
      "package.nls.pt-br.json": "allowed",
      "README.md": "allowed",
      LICENSE: "allowed",
      "provenance.json": "allowed",
      "scripts/dev-only.mjs": "forbidden",
      "test/unit/fixture.ts": "forbidden",
      "src/extension.ts": "forbidden",
    } as const;

    for (const [file, expected] of Object.entries(inventory)) {
      expect(classifyShipFile(file), file).toBe(expected);
    }
  });
});
