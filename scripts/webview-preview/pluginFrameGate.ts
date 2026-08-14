import { renderWebviewShell } from "../../apps/vscode-extension/src/webview/shared/shell.js";

// spec 349 T1 — the opaque-origin iframe CONTRACT GATE page. Renders via the REAL `renderWebviewShell` (not a
// hand-copied CSP string — the same anti-drift reasoning as `apps/vscode-extension/src/webview/ui-gate/gatePage.ts`), opting into the
// new `frameSrc: "self"` capability so the outer shell may embed the sandboxed `srcdoc` iframe that
// `plugin-frame-relay.js` mounts. `cspSource` is the server's own origin (a plain HTTP server is the closest a
// non-VS-Code harness gets to a webview's `vscode-webview://<uuid>` cspSource — same directive shape).
export function renderPluginFrameGatePage(cspSource: string): string {
  return renderWebviewShell({
    cspSource,
    title: "Tachyon plugin-frame gate (spec 349 T1)",
    styles: [],
    bundle: `${cspSource}/scripts/webview-preview/plugin-frame-relay.js`,
    mode: "static",
    frameSrc: "self",
  });
}
