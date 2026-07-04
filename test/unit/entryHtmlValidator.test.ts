import { describe, expect, it } from "vitest";
import { validateEntryHtml } from "../../src/plugins/entryHtmlValidator.js";

function expectRejected(html: string, reason: RegExp): void {
  const result = validateEntryHtml(html);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toMatch(reason);
  }
}

describe("validateEntryHtml", () => {
  it("accepts a clean self-contained document with inline script/style and data assets", () => {
    const html = `<!doctype html>
      <html>
        <head>
          <style>
            body { color: CanvasText; background-image: url("data:image/png;base64,abc"); }
          </style>
        </head>
        <body>
          <img alt="pixel" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
          <a href="#agent-1">jump</a>
          <script>window.parent.postMessage({ type: "ready" }, "*");</script>
        </body>
      </html>`;
    expect(validateEntryHtml(html)).toEqual({ ok: true });
  });

  it("rejects script src even when the source is data:", () => {
    expectRejected(`<script src="data:text/javascript,alert(1)"></script>`, /script src/i);
  });

  it("rejects link href", () => {
    expectRejected(`<link rel="stylesheet" href="data:text/css,body{}">`, /link href/i);
  });

  it("rejects remote URL attributes", () => {
    expectRejected(`<img src="https://example.com/pixel.png">`, /remote URL.*img src/i);
  });

  it("rejects protocol-relative URL attributes", () => {
    expectRejected(`<img src="//example.com/pixel.png">`, /remote URL.*img src/i);
  });

  it("rejects relative resource URL attributes", () => {
    expectRejected(`<img src="./asset.png">`, /external resource URL.*img src/i);
  });

  it("rejects vscode-webview-resource URLs", () => {
    expectRejected(`<img src="vscode-webview-resource://uuid/file.png">`, /privileged URL.*img src/i);
  });

  it("rejects vscode-resource URLs", () => {
    expectRejected(`<img src="vscode-resource:/workspace/file.png">`, /privileged URL.*img src/i);
  });

  it("rejects form action", () => {
    expectRejected(`<form method="post" action="https://example.com/submit"><button>go</button></form>`, /form action/i);
  });

  it("rejects nested iframe", () => {
    expectRejected(`<iframe srcdoc="<p>x</p>"></iframe>`, /iframe/i);
  });

  it("rejects object and embed elements", () => {
    expectRejected(`<object data="data:text/html,x"></object>`, /object/i);
    expectRejected(`<embed src="data:text/html,x">`, /embed/i);
  });

  it("rejects import maps", () => {
    expectRejected(`<script type="importmap">{"imports":{"x":"data:text/javascript,"}}</script>`, /import maps/i);
  });

  it("rejects workers in inline scripts", () => {
    expectRejected(`<script>const worker = new Worker("data:text/javascript,postMessage(1)");</script>`, /workers/i);
    expectRejected(`<script>navigator.serviceWorker.register("data:text/javascript,")</script>`, /workers/i);
    expectRejected(`<script>importScripts("data:text/javascript,")</script>`, /workers/i);
  });

  it("rejects remote URL literals in inline scripts", () => {
    expectRejected(`<script>fetch("https://example.com/api")</script>`, /remote or privileged URL literal/i);
  });

  it("rejects remote CSS urls in style blocks and style attributes", () => {
    expectRejected(`<style>.x{background:url("https://example.com/a.png")}</style>`, /remote URL.*style/i);
    expectRejected(`<div style="background:url(./a.png)"></div>`, /external resource URL.*inline style/i);
  });

  it("rejects srcset candidates that are not data:", () => {
    expectRejected(`<img srcset="data:image/png;base64,abc 1x, https://example.com/a.png 2x">`, /remote URL.*img srcset/i);
  });

  it("rejects meta refresh redirects", () => {
    expectRejected(`<meta http-equiv="refresh" content="0; url=https://example.com/">`, /meta.*refresh/i);
  });

  it("decodes entities before checking URL schemes", () => {
    expectRejected(`<img src="https&#58;//example.com/pixel.png">`, /remote URL.*img src/i);
  });

  it("rejects oversized data URLs", () => {
    expectRejected(`<img src="data:image/png;base64,${"a".repeat(256 * 1024 + 1)}">`, /size cap/i);
  });
});
