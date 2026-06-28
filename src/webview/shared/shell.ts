/**
 * spec 279 — the SHARED webview shell. The ONE place a full `<!DOCTYPE>` page is assembled for a converted
 * surface: a host `*Panel.ts` computes its `asWebviewUri` strings and calls `renderWebviewShell(...)`, which
 * emits the standard head (strict nonce'd CSP + ordered stylesheets) + `<div id="root">` + the bundle script.
 *
 * This is the anti-recurrence substrate (spec 279): a host file that uses this helper carries NO inline app
 * logic — no `acquireVsCodeApi`, no `<script>` body, no inline event handlers — which is exactly what
 * `scripts/check-webview-convention.sh` enforces. `mode` is informational (live vs render-once) and travels
 * into the surface manifest; both modes load a nonce'd bundle, so both need `script-src 'nonce-…'`.
 */

const NONCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A per-render CSP nonce (the bundle is the only script allowed to run). */
export function webviewNonce(): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
  return s;
}

export interface WebviewShellOptions {
  /** the webview's CSP source (`webview.cspSource`). */
  cspSource: string;
  /** the page title (already-trusted; callers strip `<>&` from user-derived parts). */
  title: string;
  /** stylesheet hrefs, IN ORDER (codicon → design-system → <view>.css → …), as resolved `asWebviewUri` strings. */
  styles: string[];
  /** the bundle src (resolved `asWebviewUri` string). */
  bundle: string;
  /** runtime contract: `live` (handshake + listener + actions) or `static` (render-once). Informational here. */
  mode: "live" | "static";
  /** optional `<body>` class (e.g. a code-theme class). */
  bodyClass?: string;
  /** add `blob:` to img-src (surfaces that render blob-URL images). */
  imgBlob?: boolean;
}

/** Assemble the standard webview page for a converted surface. The only sanctioned `<!DOCTYPE>` site. */
export function renderWebviewShell(o: WebviewShellOptions): string {
  const nonce = webviewNonce();
  const img = `img-src ${o.cspSource} data:${o.imgBlob ? " blob:" : ""}`;
  const csp = `default-src 'none'; ${img}; style-src 'unsafe-inline' ${o.cspSource}; font-src ${o.cspSource}; script-src 'nonce-${nonce}' ${o.cspSource};`;
  const links = o.styles.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n");
  const bodyClass = o.bodyClass ? ` class="${o.bodyClass}"` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${links}
<title>${o.title}</title>
</head>
<body${bodyClass}>
<div id="root"></div>
<script nonce="${nonce}" src="${o.bundle}"></script>
</body>
</html>`;
}
