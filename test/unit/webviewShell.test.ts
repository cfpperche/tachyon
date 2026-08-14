import { describe, it, expect } from "vitest";
import { renderWebviewShell, webviewNonce, parseShellCsp } from "../../apps/vscode-extension/src/webview/shared/shell.js";

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

describe("renderWebviewShell — spec 349 T1 frameSrc (opt-in, for a sandboxed srcdoc plugin frame)", () => {
  const base = { cspSource: "vs://x", title: "T", styles: ["/a.css"], bundle: "/v.js", mode: "live" as const };

  it("is absent by default — no existing surface's CSP gains frame-embedding ability", () => {
    const csp = parseShellCsp(renderWebviewShell(base));
    expect(csp["frame-src"]).toBeUndefined();
    expect(csp["child-src"]).toBeUndefined();
  });

  it("frameSrc:'self' adds frame-src 'self' AND the child-src 'self' fallback — never a wildcard or the (nonexistent) plugin origin", () => {
    const csp = parseShellCsp(renderWebviewShell({ ...base, frameSrc: "self" }));
    expect(csp["frame-src"]).toEqual(["'self'"]);
    expect(csp["child-src"]).toEqual(["'self'"]);
  });

  it("merges with an existing childSrc:'blob' opt-in into ONE child-src directive (never a duplicate directive line)", () => {
    const html = renderWebviewShell({ ...base, childSrc: "blob", frameSrc: "self" });
    expect([...html.matchAll(/child-src/g)]).toHaveLength(1);
    expect(parseShellCsp(html)["child-src"]).toEqual(["blob:", "'self'"]);
  });

  it("leaves every other directive untouched (default-src/img-src/style-src/font-src unaffected)", () => {
    const withFrame = parseShellCsp(renderWebviewShell({ ...base, frameSrc: "self" }));
    const without = parseShellCsp(renderWebviewShell(base));
    for (const k of ["default-src", "img-src", "style-src", "font-src"]) {
      expect(withFrame[k]).toEqual(without[k]);
    }
  });
});
