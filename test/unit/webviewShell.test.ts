import { describe, it, expect } from "vitest";
import { renderWebviewShell, webviewNonce } from "../../src/webview/shared/shell.js";

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
