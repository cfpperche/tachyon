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

/**
 * spec 485 A2 — the shared page frame's NAMED extension points: the closed set of ways a surface may
 * legitimately compose beyond the default frame. SDD 410 made the design system enforceable by having ONE
 * runtime; 485 puts the app count back, so the enforcement has to come from somewhere else. This is that
 * somewhere: a surface either takes the frame as it comes (`conform`), composes through a point NAMED here
 * (`extend`), or brings its own shell with a reason (`replace`). What fails the build is silence, never the
 * difference — a contract with no supported way out gets worked around, and a worked-around contract enforces
 * nothing. The postures live in the surface manifest (`../surfaces.ts`); `webviewConvention.test.ts` is what
 * makes them true, by checking each declaration against the host + CSS the surface actually ships.
 *
 * Each point is DETECTABLE, not honour-system — that is the whole reason the set is small and specific:
 *  - `page-chrome`  the surface styles the page frame's own elements (`html` / `body`). The design-system
 *                   baseline already owns those (`design-system.css` sets body font/colour/background/margin),
 *                   so a surface restyling them is composing its own page chrome over the shared one. The dual
 *                   pad of 2026-07-18 arrived exactly here.
 * NOT extension points, deliberately: the CSP options below (`imgBlob`, `connectSrc`, `workerSrc`, `childSrc`,
 * `frameSrc`, `scriptCspSource`). They are a security axis, orthogonal to design-system conformance — folding
 * them in here would make almost every surface `extend` and drain the word of meaning.
 */
export const SHELL_EXTENSION_POINTS = ["page-chrome"] as const;
export type ShellExtensionPoint = (typeof SHELL_EXTENSION_POINTS)[number];

/** The baseline stylesheet layer a CONFORMING surface links first, split by nature: icons, tokens, bundled
 *  faces, shared components, then the QuickPicker component. Agent Pane is the sole face-sheet exception. */
export const SHELL_BASE_STYLESHEETS = ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css"] as const;

/** Every surface, including Agent Pane, must link this token-only sheet. */
export const SHELL_DESIGN_TOKEN_STYLESHEET = "tokens.css";

/** Agent Pane skips only this sheet because the bundled Tachyon Mono face changes xterm cell metrics. */
export const SHELL_DESIGN_FACE_STYLESHEET = "faces.css";

/** The baseline sheet that carries shared components and the body baseline. */
export const SHELL_DESIGN_SYSTEM_STYLESHEET = "design-system.css";

/**
 * SDD 485 / t-32c872 — the shared sheet that gives the PAGE FRAME (`html`, `body`) the tab's height and
 * stops the page itself from scrolling: `shared/page-frame.css`. An app whose screen IS the page links it;
 * a document app that scrolls (task detail) does not.
 *
 * It is a shared sheet, so linking it is CONFORMANCE, not a `page-chrome` departure — the same status
 * `design-system.css` already has for the body baseline it owns. What the contract checks is the other
 * thing entirely: a surface that DEPENDS on a root height chain (its own CSS gives `#root` a percentage
 * height) must link a sheet that PROVIDES that chain. Declaration was never the question the Board failed:
 * it was legitimately `conform` and still broke the moment it stopped sitting next to cockpit.css.
 */
export const SHELL_PAGE_FRAME_STYLESHEET = "page-frame.css";

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
  /** spec 485 A2 — this surface's manifest `viewId`, emitted as `data-shell-surface` on `<html>`. Optional
   *  passthrough: the manifest (`../surfaces.ts`) is the declaration of record and the convention test is the
   *  enforcement, but a host that passes it makes the binding observable in the rendered page — the browser
   *  harness, `visual-qa` and anyone reading the DOM can see WHICH surface a page claims to be. */
  surface?: string;
  /** spec 485 A2 — the named extension points this render composes through, emitted as `data-shell-extends`.
   *  When present it must match the surface's manifest `extensionPoints` exactly (webviewConvention.test.ts
   *  checks that); it never grants anything the manifest has not already declared. */
  extend?: readonly ShellExtensionPoint[];
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
  // spec 485 A2 — the posture declaration rides on the root element, so a rendered page carries its own
  // conformance claim (attribute-only: no layout, no style, nothing a human sees).
  const shellAttrs = `${o.surface ? ` data-shell-surface="${o.surface}"` : ""}${o.extend?.length ? ` data-shell-extends="${[...o.extend].join(" ")}"` : ""}`;
  return `<!DOCTYPE html>
<html lang="en"${shellAttrs}>
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
