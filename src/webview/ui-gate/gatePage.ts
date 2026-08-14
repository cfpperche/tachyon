import { renderWebviewShell, SHELL_BASE_STYLESHEETS } from "../../../apps/vscode-extension/src/webview/shared/shell";

// spec 342 — the ui-gate page HTML, factored out of the browser-test HTTP server so a PLAIN unit test
// (test/unit/cssOrderSnapshot.test.ts) can assert the stylesheet order without launching a browser. The
// required order (spec.md): tokens.css → faces.css → design-system.css → vscode-theme.css → Tailwind. This
// surface has no surface-specific CSS of its own yet, so the chain ends at the Tailwind bundle.
export function renderGatePage(cspSource: string): string {
  return renderWebviewShell({
    cspSource,
    title: "Tachyon UI Gate",
    styles: [
      ...SHELL_BASE_STYLESHEETS.map((stylesheet) => `${cspSource}/dist/webview/${stylesheet}`),
      `${cspSource}/dist/webview/vscode-theme.css`,
      `${cspSource}/dist/webview/ui-gate.tailwind.css`,
    ],
    bundle: `${cspSource}/dist/webview/ui-gate.js`,
    mode: "static",
  });
}
