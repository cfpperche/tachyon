import { describe, it, expect } from "vitest";
import { renderWebviewShell, webviewNonce, parseShellCsp } from "../../src/webview/shared/shell.js";

// spec 279 — the shared webview shell helper (the one sanctioned <!DOCTYPE site). Pure string assembly.

describe("renderWebviewShell", () => {
  const base = { cspSource: "vscode-resource://x", title: "T", styles: ["/a.css", "/b.css"], bundle: "/v.js", mode: "live" as const };

  it("emits the doctype, ordered stylesheets, a root, and a nonce'd bundle script", () => {
    const html = renderWebviewShell(base);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.indexOf("/a.css")).toBeLessThan(html.indexOf("/b.css")); // order preserved
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/<script nonce="[A-Za-z0-9]{32}" src="\/v\.js"><\/script>/);
  });

  it("builds a strict nonce'd CSP whose script nonce matches the bundle tag (only the bundle runs)", () => {
    const html = renderWebviewShell(base);
    const cspNonce = html.match(/script-src 'nonce-([A-Za-z0-9]{32})'/)?.[1];
    const tagNonce = html.match(/<script nonce="([A-Za-z0-9]{32})"/)?.[1];
    expect(cspNonce).toBeTruthy();
    expect(cspNonce).toBe(tagNonce);
    expect(html).toContain("default-src 'none'");
  });

  it("imgBlob and bodyClass are opt-in", () => {
    expect(renderWebviewShell(base)).not.toContain("blob:");
    expect(renderWebviewShell({ ...base, imgBlob: true })).toContain("img-src vscode-resource://x data: blob:");
    expect(renderWebviewShell({ ...base, bodyClass: "tac-theme-dark" })).toContain('<body class="tac-theme-dark">');
  });

  it("webviewNonce is 32 url-safe chars", () => {
    expect(webviewNonce()).toMatch(/^[A-Za-z0-9]{32}$/);
  });
});

describe("renderWebviewShell — spec 280 structured options (parity for the migrated panels)", () => {
  const base = { cspSource: "vs://x", title: "T", styles: ["/a.css"], bundle: "/v.js", mode: "live" as const };

  it("default script-src includes cspSource; scriptCspSource:false makes it nonce-only (sidebar)", () => {
    expect(parseShellCsp(renderWebviewShell(base))["script-src"]).toEqual([expect.stringMatching(/^'nonce-/), "vs://x"]);
    expect(parseShellCsp(renderWebviewShell({ ...base, scriptCspSource: false }))["script-src"]).toEqual([expect.stringMatching(/^'nonce-/)]);
  });

  it("structured CSP fields add connect/worker/child-src (pin-studio / excalidraw)", () => {
    const csp = parseShellCsp(renderWebviewShell({ ...base, imgBlob: true, connectSrc: true, workerSrc: "blob", childSrc: "blob" }));
    expect(csp["img-src"]).toContain("blob:");
    expect(csp["connect-src"]).toEqual(["vs://x"]);
    expect(csp["worker-src"]).toEqual(["blob:"]);
    expect(csp["child-src"]).toEqual(["blob:"]);
  });

  it("bootstrapGlobals emit nonce'd JSON-encoded globals BEFORE the bundle, sharing the bundle's nonce", () => {
    const html = renderWebviewShell({ ...base, bootstrapGlobals: { __mermaidSrc: "/m.js", __codeThemeForced: "dark" } });
    expect(html).toContain('window.__mermaidSrc="/m.js";window.__codeThemeForced="dark";');
    expect(html.indexOf("__mermaidSrc")).toBeLessThan(html.indexOf('src="/v.js"')); // bootstrap before bundle
    const nonces = [...html.matchAll(/<script nonce="([A-Za-z0-9]{32})"/g)].map((m) => m[1]);
    expect(nonces.length).toBe(2); // bootstrap + bundle
    expect(nonces[0]).toBe(nonces[1]); // same nonce, both allowed by the CSP
  });

  it("bootstrap values are JSON-encoded + `<` escaped — a hostile value can't break out of the script", () => {
    const html = renderWebviewShell({ ...base, bootstrapGlobals: { x: '</script><img onerror=alert(1)>' } });
    expect(html).not.toContain("</script><img"); // no `</script>` breakout (escaped to <)
    expect(html).toContain("\\u003c/script>\\u003cimg onerror=alert(1)>"); // present, but inert/escaped
  });
});
