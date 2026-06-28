import { describe, it, expect } from "vitest";
import { renderWebviewShell, parseShellCsp, type WebviewShellOptions } from "../../src/webview/shared/shell.js";

// spec 280 — the PARITY gate (the dueto's real guard, not visual-only). For each panel migrated to
// renderWebviewShell, assert the rendered shell's CSP directive SET + stylesheet/script ORDER + body class +
// bootstrap-before-bundle match the panel's pre-migration shape. A CSP/order regression renders blank only
// later; this catches it cheaply. (The host *Panel.ts now just calls renderWebviewShell with these option-sets,
// so asserting the shell output for each set IS the migration's parity proof.)

const CSP = "vscode-resource://host";
const opts = (o: Partial<WebviewShellOptions>): WebviewShellOptions => ({ cspSource: CSP, title: "T", styles: [], bundle: "/x.js", mode: "live", ...o });

/** the standard CSP every panel had pre-migration except sidebar (nonce-only) + pin-studio (extra directives). */
const STANDARD = {
  "default-src": ["'none'"],
  "img-src": [CSP, "data:"],
  "style-src": ["'unsafe-inline'", CSP],
  "font-src": [CSP],
  "script-src": [expect.stringMatching(/^'nonce-/), CSP],
};

const linkOrder = (html: string): string[] => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);

describe("spec 280 — migrated-panel shell parity", () => {
  it("handoff: standard CSP + codicon→design-system→handoff.css order", () => {
    const html = renderWebviewShell(opts({ styles: ["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/handoff.css"], bundle: "/dist/webview/handoff.js" }));
    expect(parseShellCsp(html)).toEqual(STANDARD);
    expect(linkOrder(html)).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/handoff.css"]);
  });

  it("plugins: standard CSP + codicon→design-system→plugins.css order", () => {
    const html = renderWebviewShell(opts({ styles: ["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/plugins.css"], bundle: "/dist/webview/plugins.js" }));
    expect(parseShellCsp(html)).toEqual(STANDARD);
    expect(linkOrder(html)).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/plugins.css"]);
  });

  it("sidebar: keeps img blob: + script-src nonce-ONLY (no cspSource)", () => {
    const csp = parseShellCsp(renderWebviewShell(opts({ imgBlob: true, scriptCspSource: false, styles: ["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/sidebar.css"], bundle: "/dist/webview/sidebar.js" })));
    expect(csp["img-src"]).toEqual([CSP, "data:", "blob:"]);
    expect(csp["script-src"]).toEqual([expect.stringMatching(/^'nonce-/)]); // nonce only — no cspSource
  });

  it("activity: standard CSP + body theme class + bootstrap globals BEFORE the bundle, same nonce", () => {
    const html = renderWebviewShell(opts({
      bodyClass: "tac-theme-dark",
      styles: ["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/activity.css"],
      bundle: "/dist/webview/activity.js",
      bootstrapGlobals: { __mermaidSrc: "/dist/webview/mermaid.js", __katexSrc: "/dist/webview/katex.js", __katexCssUri: "/dist/webview/katex.min.css", __codeThemeForced: "dark" },
    }));
    expect(parseShellCsp(html)).toEqual(STANDARD);
    expect(html).toContain('<body class="tac-theme-dark">');
    expect(html).toContain('window.__mermaidSrc="/dist/webview/mermaid.js";');
    expect(html).toContain('window.__codeThemeForced="dark";');
    expect(html.indexOf("__mermaidSrc")).toBeLessThan(html.indexOf('src="/dist/webview/activity.js"'));
    const nonces = [...html.matchAll(/<script nonce="([A-Za-z0-9]{32})"/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBe(nonces[1]);
  });
});
