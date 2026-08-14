import { describe, expect, it } from "vitest";
import { renderGatePage } from "../../apps/vscode-extension/src/webview/ui-gate/gatePage.js";

// spec 342 T2 — the FINAL CSS order `renderWebviewShell` produces for a Tailwind-opted surface must stay
// tokens.css → faces.css → design-system.css → vscode-theme.css → Tailwind layers → surface CSS
// scenario); a reorder is a silent regression (later rules winning a cascade tie they shouldn't). This
// snapshot fails the moment gatePage.ts's `styles` order changes, without needing a browser.
describe("webview shell CSS order (ui-gate surface)", () => {
  it("keeps design-system → vscode-theme → tailwind order", () => {
    const html = renderGatePage("http://localhost:5199");
    const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      "http://localhost:5199/dist/webview/codicon.css",
      "http://localhost:5199/dist/webview/tokens.css",
      "http://localhost:5199/dist/webview/faces.css",
      "http://localhost:5199/dist/webview/design-system.css",
      "http://localhost:5199/dist/webview/quick-picker.css",
      "http://localhost:5199/dist/webview/vscode-theme.css",
      "http://localhost:5199/dist/webview/ui-gate.tailwind.css",
    ]);
  });
});
