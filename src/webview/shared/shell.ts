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
  /** include `cspSource` in `script-src` (default true). The sidebar webview-VIEW passes `false` (nonce-only). */
  scriptCspSource?: boolean;
  /** spec 280 — add `connect-src ${cspSource}` (excalidraw). */
  connectSrc?: boolean;
  /** spec 280 — add `worker-src blob:` (excalidraw). */
  workerSrc?: "blob";
  /** spec 280 — add `child-src blob:` (excalidraw). */
  childSrc?: "blob";
  /** spec 349 T1 — add `frame-src 'self'` (+ `child-src 'self'`, the CSP1/2 fallback) so the shell may embed a
   *  sandboxed `srcdoc` iframe (an opaque-origin plugin surface). Opt-in; no existing surface sets this — a
   *  `srcdoc` navigation is checked against the EMBEDDER's own url, so `'self'` is the correct (and narrowest
   *  possible) source-list entry, never a wildcard or the plugin's own origin (it has none). */
  frameSrc?: "self";
  /** spec 280 — nonce'd inline globals emitted BEFORE the bundle: `window.<k> = <JSON(v)>`. The shell owns the
   *  nonce + JSON-encodes each value (no caller-authored JS); the ONE sanctioned inline-script site. Values may be
   *  any JSON-serializable shape (activity: URL strings + a theme; pin-studio: an asset OBJECT + a path string). */
  bootstrapGlobals?: Record<string, unknown>;
  /** Minimal VS Code reload state. The bundle entrypoint persists this through `vscode.setState()`. */
  persistedState?: unknown;
  /** spec 410 — load bundle as ES module (cockpit code-split chunks). */
  module?: boolean;
}

/** Assemble the standard webview page for a converted surface. The only sanctioned `<!DOCTYPE>` site. */
export function renderWebviewShell(o: WebviewShellOptions): string {
  const nonce = webviewNonce();
  const scriptSrc = `script-src 'nonce-${nonce}'${o.scriptCspSource === false ? "" : ` ${o.cspSource}`}`;
  // child-src has two independent opt-in sources (blob: for excalidraw, 'self' for a plugin srcdoc frame) that
  // must merge into ONE directive — a repeated directive name is invalid CSP and only the first occurrence is
  // honored, so token-collect first rather than pushing two separate "child-src …" lines.
  const childSrcTokens = [...(o.childSrc === "blob" ? ["blob:"] : []), ...(o.frameSrc === "self" ? ["'self'"] : [])];
  const directives = [
    "default-src 'none'",
    `img-src ${o.cspSource} data:${o.imgBlob ? " blob:" : ""}`,
    `style-src 'unsafe-inline' ${o.cspSource}`,
    `font-src ${o.cspSource}`,
    scriptSrc,
    ...(o.connectSrc ? [`connect-src ${o.cspSource}`] : []),
    ...(o.workerSrc === "blob" ? ["worker-src blob:"] : []),
    ...(o.frameSrc === "self" ? ["frame-src 'self'"] : []),
    ...(childSrcTokens.length ? [`child-src ${childSrcTokens.join(" ")}`] : []),
  ];
  const csp = `${directives.join("; ")};`;
  const links = o.styles.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n");
  const bodyClass = o.bodyClass ? ` class="${o.bodyClass}"` : "";
  // JSON.stringify leaves `<` literal, so a value containing `</script>` would terminate the inline script even
  // inside a JS string (the HTML parser is context-blind). Escape `<` → < — the standard inline-JSON defense.
  const jsonInline = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");
  const globals = { ...(o.persistedState !== undefined ? { __tachyonPersistedState: o.persistedState } : {}), ...(o.bootstrapGlobals ?? {}) };
  const bootstrap = Object.keys(globals).length > 0
    ? `<script nonce="${nonce}">${Object.entries(globals).map(([k, v]) => `window.${k}=${jsonInline(v)};`).join("")}</script>\n`
    : "";
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
${bootstrap}<script nonce="${nonce}"${o.module ? ' type="module"' : ""} src="${o.bundle}"></script>
</body>
</html>`;
}

/** spec 280 — parse a rendered shell's CSP `<meta>` into a directive→tokens map, for order-independent parity
 *  assertions (a CSP regression renders blank only later; a parsed-set check catches it cheaply). */
export function parseShellCsp(html: string): Record<string, string[]> {
  const content = html.match(/Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
  const out: Record<string, string[]> = {};
  for (const part of content.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, ...tokens] = part.split(/\s+/);
    out[name] = tokens;
  }
  return out;
}
