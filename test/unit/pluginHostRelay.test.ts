import { describe, expect, it } from "vitest";
import { assemblePluginSrcdoc, isRelayActionMessage, messageTooLarge } from "../../src/webview/plugin-host/relay.js";

describe("plugin host relay (spec 349 T10)", () => {
  it("nonce-stamps plugin inline scripts and owns the srcdoc CSP", () => {
    const srcdoc = assemblePluginSrcdoc(
      `<!doctype html><html><head>
        <meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'">
      </head><body><script>window.parent.postMessage({ type: "ready" }, "*")</script></body></html>`,
      "abc123",
    );
    expect(srcdoc).toContain(`script-src 'nonce-abc123'`);
    expect(srcdoc).not.toContain("script-src 'unsafe-inline'");
    expect(srcdoc).toContain(`<script nonce="abc123">window.parent.postMessage`);
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("frame-src 'none'");
  });

  it("does not stamp external script tags", () => {
    const srcdoc = assemblePluginSrcdoc(`<script src="data:text/javascript,alert(1)"></script><script>ok()</script>`, "n");
    expect(srcdoc).toContain(`<script src="data:text/javascript,alert(1)"></script>`);
    expect(srcdoc).toContain(`<script nonce="n">ok()</script>`);
  });

  it("recognizes action messages and byte-caps relay input", () => {
    expect(isRelayActionMessage({ type: "pluginUiAction", action: "focusAgent" })).toBe(true);
    expect(isRelayActionMessage({ type: "other" })).toBe(false);
    expect(messageTooLarge({ body: "x".repeat(65 * 1024) })).toBe(true);
    expect(messageTooLarge({ body: "small" })).toBe(false);
  });
});
