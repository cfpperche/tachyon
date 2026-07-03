import { renderWebviewShell } from "../shared/shell";

// spec 342 — the ui-gate page HTML, factored out of the browser-test HTTP server so a PLAIN unit test
// (test/unit/cssOrderSnapshot.test.ts) can assert the stylesheet order without launching a browser. The
// required order (spec.md): design-system.css → vscode-theme.css → Tailwind layers → surface CSS. This
// surface has no surface-specific CSS of its own yet, so the chain ends at the Tailwind bundle.
export function renderGatePage(cspSource: string): string {
  return renderWebviewShell({
    cspSource,
    title: "Tachyon UI Gate",
    styles: [
      `${cspSource}/dist/webview/codicon.css`,
      `${cspSource}/dist/webview/design-system.css`,
      `${cspSource}/dist/webview/vscode-theme.css`,
      `${cspSource}/dist/webview/ui-gate.tailwind.css`,
    ],
    bundle: `${cspSource}/dist/webview/ui-gate.js`,
    mode: "static",
  });
}
